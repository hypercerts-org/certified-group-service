import 'dotenv/config'
import express from 'express'
import { IdResolver, MemoryCache } from '@atproto/identity'
import pino from 'pino'
import { pinoHttp } from 'pino-http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { createGroupServer } from './server.js'
import { loadConfig } from './config.js'
import { AuthVerifier } from './auth/verifier.js'
import { PermissionSetResolver } from './auth/permission-set-resolver.js'
import { NonceCache } from './auth/nonce.js'
import { RbacChecker } from './rbac/check.js'
import { registerXrpcMethods } from './api/index.js'
import { createFallbackErrorHandler } from './api/error-handler.js'
import { createHealthHandler } from './health.js'
import { runGlobalMigrations } from './db/migrate.js'
import { openSqliteDb } from './db/sqlite.js'
import { GroupDbPool } from './db/group-db-pool.js'
import { MemberIndex, backfillMemberIndex } from './db/member-index.js'
import { PdsAgentPool } from './pds/agent.js'
import { AuditLogger } from './audit.js'
import { buildDidDocument } from './did-document.js'
import type { AppContext } from './context.js'
import type { GlobalDatabase } from './db/schema.js'

async function main() {
  const config = loadConfig()
  const logger = pino({ level: config.logLevel })

  mkdirSync(config.dataDir, { recursive: true })

  // Global SQLite database
  const globalDbPath = join(config.dataDir, 'global.sqlite')
  const { db: globalDb } = openSqliteDb<GlobalDatabase>(globalDbPath)

  await runGlobalMigrations(globalDb)
  logger.info('Global migrations complete')

  // Per-group SQLite databases
  const groupDbs = new GroupDbPool(join(config.dataDir, 'groups'))

  // DID resolution
  const didCache = new MemoryCache(config.didCacheTtlMs, config.didCacheTtlMs * 2)
  const idResolver = new IdResolver({ plcUrl: config.plcUrl, didCache })

  // Load managed group DIDs and run per-group migrations
  const groups = await globalDb.selectFrom('groups').select('did').execute()

  await Promise.all(groups.map((group) => groupDbs.migrateGroup(group.did)))
  logger.info({ groups: groups.length }, 'Per-group databases initialized')

  // Backfill member_index from existing group DBs (idempotent)
  const backfilled = await backfillMemberIndex(globalDb, groupDbs)
  logger.info({ backfilled }, 'Member index backfill complete')

  // Auth & RBAC
  const nonceCache = new NonceCache(globalDb)
  const nonceCleanupInterval = setInterval(
    () => nonceCache.cleanup().catch((err) => logger.error(err)),
    60_000,
  )
  const authVerifier = new AuthVerifier(
    idResolver,
    nonceCache,
    globalDb,
    config.serviceDid,
    groupDbs,
    undefined,
    undefined,
    logger,
    config.adminPassword,
  )
  const rbac = new RbacChecker()
  const permissionSets = new PermissionSetResolver(idResolver, { logger })

  // Express app
  const app = express()
  app.set('trust proxy', 1)
  app.use(pinoHttp({ logger }))

  // XRPC routes
  const pdsAgents = new PdsAgentPool(globalDb, Buffer.from(config.encryptionKey, 'hex'))
  const audit = new AuditLogger()
  const memberIndex = new MemberIndex(globalDbPath)
  const ctx: AppContext = {
    config,
    globalDb,
    globalDbPath,
    groupDbs,
    authVerifier,
    idResolver,
    permissionSets,
    rbac,
    pdsAgents,
    audit,
    memberIndex,
    logger,
  }

  // Health check. Reports liveness, service name and version, gated on a
  // probe of the global DB. `/xrpc/_health` mirrors `/health` — the upstream
  // PDS exposes _health from its own code, but the group service has no such
  // upstream, so we serve it ourselves. It must be registered before the
  // XRPC router so it wins over the catch-all /xrpc/* handler.
  const healthHandler = createHealthHandler(globalDb)
  app.get('/health', healthHandler)
  app.get('/xrpc/_health', healthHandler)

  // did:web document so the service DID resolves (issue #29 / HYPER-484) and the
  // #certified_group_service service entry is published for proxying + scope aud.
  const didDocument = buildDidDocument(config.serviceDid, config.serviceUrl)
  app.get('/.well-known/did.json', (_req, res) => {
    res.json(didDocument)
  })

  // XRPC server — handles all /xrpc/* routes, including group.register and
  // group.import (service-auth methods) and per-group methods
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const xrpcServer = createGroupServer(join(__dirname, '..', 'lexicons'))
  registerXrpcMethods(xrpcServer, ctx)
  app.use(xrpcServer.router)

  // Fallback error handler for any non-XRPC routes (e.g. /health)
  app.use(createFallbackErrorHandler(logger))

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, groups: groups.length }, 'Group Service started')
  })

  // Track open sockets so we can destroy idle keep-alive connections on shutdown
  const openSockets = new Set<import('node:net').Socket>()
  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(nonceCleanupInterval)
    // Stop accepting new connections and destroy lingering keep-alive sockets concurrently
    const closeServer = new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
    logger.info(`Destroying ${openSockets.size} open socket(s) to unblock server close`)
    openSockets.forEach((s) => s.destroy())
    await closeServer
    await groupDbs.destroyAll()
    await globalDb.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
