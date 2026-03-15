import 'dotenv/config'
import express from 'express'
import { IdResolver } from '@atproto/identity'
import pino from 'pino'
import { pinoHttp } from 'pino-http'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config.js'
import { AuthVerifier } from './auth/verifier.js'
import { NonceCache } from './auth/nonce.js'
import { RbacChecker } from './rbac/check.js'
import { registerRoutes } from './api/index.js'
import { xrpcErrorHandler } from './api/error-handler.js'
import { runGlobalMigrations } from './db/migrate.js'
import { openSqliteDb } from './db/sqlite.js'
import { GroupDbPool } from './db/group-db-pool.js'
import { PdsAgentPool } from './pds/agent.js'
import { AuditLogger } from './audit.js'
import type { AppContext } from './context.js'
import type { GlobalDatabase } from './db/schema.js'

async function main() {
  const config = loadConfig()
  const logger = pino({ level: config.logLevel })

  mkdirSync(config.dataDir, { recursive: true })

  // Global SQLite database
  const globalDb = openSqliteDb<GlobalDatabase>(join(config.dataDir, 'global.sqlite'))

  await runGlobalMigrations(globalDb)
  logger.info('Global migrations complete')

  // Per-group SQLite databases
  const groupDbs = new GroupDbPool(join(config.dataDir, 'groups'))

  // DID resolution
  const idResolver = new IdResolver({ plcUrl: config.plcUrl })

  // Load managed group DIDs and run per-group migrations
  const groups = await globalDb.selectFrom('groups').select('did').execute()

  await Promise.all(groups.map((group) => groupDbs.migrateGroup(group.did)))
  logger.info({ groups: groups.length }, 'Per-group databases initialized')

  // Auth & RBAC
  const nonceCache = new NonceCache(globalDb)
  const nonceCleanupInterval = setInterval(
    () => nonceCache.cleanup().catch((err) => logger.error(err)),
    60_000,
  )
  const authVerifier = new AuthVerifier(idResolver, nonceCache, globalDb)
  const rbac = new RbacChecker()

  // Express app
  const app = express()
  app.set('trust proxy', 1)
  app.use(pinoHttp({ logger }))

  // JSON parsing: skip for uploadBlob (needs raw stream), 1MB limit otherwise
  const jsonParser = express.json({ limit: '1mb' })
  app.use((req, res, next) => {
    if (req.path === '/xrpc/com.atproto.repo.uploadBlob') return next()
    jsonParser(req, res, next)
  })

  // Health check
  app.get('/health', async (_req, res) => {
    try {
      await globalDb.selectFrom('groups').select('did').limit(1).execute()
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'error', message: 'database unreachable' })
    }
  })

  // XRPC routes
  const pdsAgents = new PdsAgentPool(globalDb, Buffer.from(config.encryptionKey, 'hex'))
  const audit = new AuditLogger()
  const ctx: AppContext = {
    config, globalDb, groupDbs, authVerifier, rbac, pdsAgents, audit, logger,
  }
  registerRoutes(app, ctx)

  // Error middleware (must be registered AFTER routes)
  app.use(xrpcErrorHandler(logger))

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
      server.close((err) => (err ? reject(err) : resolve()))
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
