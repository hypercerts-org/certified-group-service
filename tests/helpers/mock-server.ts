import type { AppContext } from '../../src/context.js'
import type { Config } from '../../src/config.js'
import { RbacChecker } from '../../src/rbac/check.js'
import { AuditLogger } from '../../src/audit.js'
import { createTestGlobalDb, createTestGroupDb } from './test-db.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../../src/db/schema.js'

export async function createTestContext(overrides?: Partial<AppContext>): Promise<{
  ctx: AppContext
  globalDb: Kysely<GlobalDatabase>
  groupDb: Kysely<GroupDatabase>
}> {
  const globalDb = await createTestGlobalDb()
  const groupDb = await createTestGroupDb()

  const mockConfig: Config = {
    port: 3000,
    publicHostname: 'test.example.com',
    dataDir: '/tmp/test',
    encryptionKey: 'a'.repeat(64),
    plcUrl: 'https://plc.directory',
    didCacheTtlMs: 300_000,
    maxBlobSize: 10 * 1024 * 1024,
    logLevel: 'error',
  }

  const mockGroupDbs = {
    get: () => groupDb,
    migrateGroup: async () => {},
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
                data: { uri: 'at://did:plc:testgroup/app.bsky.feed.post/abc123', cid: 'bafytest' },
              }),
              deleteRecord: async () => ({ data: {} }),
              putRecord: async (_input: unknown) => ({
                data: { uri: 'at://did:plc:testgroup/app.bsky.feed.post/abc123', cid: 'bafytest' },
              }),
              uploadBlob: async () => ({
                data: { blob: { ref: { $link: 'bafyblob' }, mimeType: 'image/png', size: 1024 } },
              }),
            },
          },
        },
      }
      return fn(agent)
    },
    invalidate: () => {},
  }

  const mockAuthVerifier = {
    verify: async () => ({ iss: 'did:plc:testuser', aud: 'did:plc:testgroup' }),
  }

  const ctx: AppContext = {
    config: mockConfig,
    globalDb,
    groupDbs: mockGroupDbs as any,
    authVerifier: mockAuthVerifier as any,
    rbac: new RbacChecker(),
    pdsAgents: mockPdsAgents as any,
    audit: new AuditLogger(),
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
    ...overrides,
  }

  return { ctx, globalDb, groupDb }
}

export const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }

export async function seedMember(
  groupDb: Kysely<GroupDatabase>,
  memberDid: string,
  role: string,
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
