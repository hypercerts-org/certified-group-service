import type Database from 'better-sqlite3'
import type { AppContext } from '../../src/context.js'
import type { Config } from '../../src/config.js'
import { RbacChecker } from '../../src/rbac/check.js'
import type { Role } from '../../src/rbac/permissions.js'
import { AuditLogger } from '../../src/audit.js'
import { TestMemberIndex } from '../../src/db/member-index.js'
import { createTestGlobalDb, createTestGroupDb } from './test-db.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../../src/db/schema.js'
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGroupServer } from '../../src/server.js'
import { createFallbackErrorHandler } from '../../src/api/error-handler.js'
import type { Server } from '@atproto/xrpc-server'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LEXICON_DIR = join(__dirname, '../../lexicons')

export async function createTestContext(overrides?: Partial<AppContext>): Promise<{
  ctx: AppContext
  globalDb: Kysely<GlobalDatabase>
  globalRaw: Database.Database
  groupDb: Kysely<GroupDatabase>
  groupRaw: Database.Database
}> {
  const { db: globalDb, raw: globalRaw } = await createTestGlobalDb()
  const { db: groupDb, raw: groupRaw } = await createTestGroupDb()

  const mockConfig: Config = {
    port: 3000,
    serviceUrl: 'https://test.example.com',
    serviceDid: 'did:web:test.example.com',
    dataDir: '/tmp/test',
    encryptionKey: 'a'.repeat(64),
    groupPdsUrl: 'https://pds.example.com',
    plcUrl: 'https://plc.directory',
    didCacheTtlMs: 300_000,
    maxBlobSize: 10 * 1024 * 1024,
    logLevel: 'error',
  }

  const mockGroupDbs = {
    get: () => groupDb,
    getRaw: () => groupRaw,
    migrateGroup: async () => {},
    destroyGroup: async () => {},
    destroyAll: async () => {},
  }

  const mockPdsAgents = {
    get: async () => ({}),
    withAgent: async (_did: string, fn: (agent: any) => Promise<any>) => {
      const agent = {
        com: {
          atproto: {
            repo: {
              createRecord: async (_input: unknown) => ({
                data: {
                  uri: 'at://did:plc:testgroup/app.bsky.feed.post/abc123',
                  cid: 'bafytest',
                },
              }),
              deleteRecord: async () => ({ data: {} }),
              putRecord: async (_input: unknown) => ({
                data: {
                  uri: 'at://did:plc:testgroup/app.bsky.feed.post/abc123',
                  cid: 'bafytest',
                },
              }),
              uploadBlob: async () => ({
                data: {
                  blob: {
                    ref: { $link: 'bafyblob' },
                    mimeType: 'image/png',
                    size: 1024,
                  },
                },
              }),
            },
          },
        },
      }
      return fn(agent)
    },
    invalidate: () => {},
  }

  const memberIndex = new TestMemberIndex(globalRaw)

  const ctx: AppContext = {
    config: mockConfig,
    globalDb,
    globalDbPath: ':memory:',
    groupDbs: mockGroupDbs as any,
    authVerifier: mockAuth('did:plc:testuser'),
    idResolver: mockIdResolver(),
    rbac: new RbacChecker(),
    pdsAgents: mockPdsAgents as any,
    audit: new AuditLogger(),
    memberIndex,
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    } as any,
    ...overrides,
  }

  return { ctx, globalDb, globalRaw, groupDb, groupRaw }
}

export const silentLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
}

export async function seedMember(
  groupDb: Kysely<GroupDatabase>,
  memberDid: string,
  role: Role,
  addedBy = 'did:plc:owner',
): Promise<void> {
  await groupDb
    .insertInto('group_members')
    .values({
      member_did: memberDid,
      role,
      added_by: addedBy,
    })
    .execute()
}

export async function seedMemberWithIndex(
  groupDb: Kysely<GroupDatabase>,
  globalDb: Kysely<GlobalDatabase>,
  memberDid: string,
  groupDid: string,
  role: Role,
  addedBy = 'did:plc:owner',
): Promise<void> {
  await groupDb
    .insertInto('group_members')
    .values({
      member_did: memberDid,
      role,
      added_by: addedBy,
    })
    .execute()
  // Read back added_at from group DB to keep index in sync
  const row = await groupDb
    .selectFrom('group_members')
    .select('added_at')
    .where('member_did', '=', memberDid)
    .executeTakeFirstOrThrow()
  await globalDb
    .insertInto('member_index')
    .values({
      member_did: memberDid,
      group_did: groupDid,
      role,
      added_by: addedBy,
      added_at: row.added_at,
    })
    .execute()
}

export async function seedAuthorship(
  groupDb: Kysely<GroupDatabase>,
  recordUri: string,
  authorDid: string,
  collection: string,
): Promise<void> {
  await groupDb
    .insertInto('group_record_authors')
    .values({
      record_uri: recordUri,
      author_did: authorDid,
      collection,
    })
    .execute()
}

export function createTestApp(
  ctx: AppContext,
  registerHandlers: (server: Server, ctx: AppContext) => void,
): express.Express {
  const xrpcServer = createGroupServer(LEXICON_DIR)
  registerHandlers(xrpcServer, ctx)

  const app = express()
  app.use(xrpcServer.router)
  app.use(createFallbackErrorHandler(silentLogger as any))
  return app
}

/**
 * Mock AuthVerifier mirroring the real surface after the #27 fix.
 *
 * By default it simulates the **legacy** path (group taken from `aud`, so
 * `groupDid` is set on the credential and `legacyAud` is true) — matching the
 * existing tests, which mint `aud = the group DID`. Tests exercising the new
 * path override `verify`/`xrpcAuth` to return `groupDid: undefined` (procedures
 * resolve from the body) or `legacyAud: false`.
 *
 * `resolveRepoToGroup` accepts only the configured group (`aud`): the group DID
 * itself, or the handle `group.example.com`. Any other value throws, mirroring
 * the real verifier rejecting an unregistered group — so a handler resolving
 * `input.body.repo` exercises the same accept/reject behaviour without a real
 * groups table.
 */
export function mockAuth(iss: string, aud: string = 'did:plc:testgroup') {
  return {
    verify: async () => ({ iss, groupDid: aud, legacyAud: true }),
    verifyServiceAuth: async () => ({ iss }),
    resolveRepoToGroup: async (repo: string) => {
      if (repo === aud || repo === 'group.example.com') return aud
      const { AuthRequiredError } = await import('@atproto/xrpc-server')
      throw new AuthRequiredError('Unknown group')
    },
    xrpcAuth() {
      return async ({ req }: { req: any }) => {
        const { iss, groupDid, legacyAud } = await this.verify(req)
        return { credentials: { callerDid: iss, groupDid, legacyAud, authKind: 'jwt' } }
      }
    },
    xrpcServiceAuth() {
      return async ({ req }: { req: any }) => {
        const { iss } = await this.verifyServiceAuth(req)
        return { credentials: { callerDid: iss } }
      }
    },
  } as any
}

/**
 * Mock AuthVerifier simulating the **new** (#27-fixed) path: `aud` is the
 * service DID and the group is named by an explicit `repo`. For queries the
 * group is read from `req.query.repo` (resolved here); for body-input
 * procedures it is left undefined so the handler resolves `input.body.repo`.
 * `legacyAud` is always false, so no deprecation signal fires.
 */
export function mockAuthNewPath(iss: string, group: string = 'did:plc:testgroup') {
  const resolveRepoToGroup = async (repo: string) => {
    if (repo === group || repo === 'group.example.com') return group
    const { AuthRequiredError } = await import('@atproto/xrpc-server')
    throw new AuthRequiredError('Unknown group')
  }
  return {
    verify: async (req: any) => {
      const repo = typeof req?.query?.repo === 'string' ? req.query.repo : undefined
      const groupDid = repo !== undefined ? await resolveRepoToGroup(repo) : undefined
      return { iss, groupDid, legacyAud: false }
    },
    verifyServiceAuth: async () => ({ iss }),
    resolveRepoToGroup,
    xrpcAuth() {
      return async ({ req }: { req: any }) => {
        const { iss: callerDid, groupDid, legacyAud } = await this.verify(req)
        return { credentials: { callerDid, groupDid, legacyAud, authKind: 'jwt' } }
      }
    },
    xrpcServiceAuth() {
      return async ({ req }: { req: any }) => {
        const { iss: callerDid } = await this.verifyServiceAuth(req)
        return { credentials: { callerDid } }
      }
    },
  } as any
}

/**
 * Minimal IdResolver mock. By default resolves any DID to atproto data whose
 * `pds` points at the test PDS, so the group.import success path works out of
 * the box. Tests override `did.resolveAtprotoData` to exercise other cases
 * (e.g. a different PDS, or a throw for an unresolvable DID).
 */
export function mockIdResolver(pdsUrl = 'https://pds.example.com') {
  return {
    did: {
      resolveAtprotoData: async (did: string) => ({
        did,
        signingKey: 'did:key:zQ3shmockSigningKey',
        handle: 'imported.pds.example.com',
        pds: pdsUrl,
      }),
    },
  } as any
}
