import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Express } from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { createTestContext, createTestApp, seedMember, seedAuthorship } from './helpers/mock-server.js'
import putRecordHandler from '../src/api/repo/putRecord.js'

// The mock auth verifier always returns callerDid='did:plc:testuser', groupDid='did:plc:testgroup'
const GROUP_DID = 'did:plc:testgroup'
const CALLER_DID = 'did:plc:testuser'
const OTHER_AUTHOR = 'did:plc:other-author'
const COLLECTION = 'app.bsky.feed.post'
const RKEY = 'somekey'
const RECORD_URI = `at://${GROUP_DID}/${COLLECTION}/${RKEY}`

describe('putRecord — cross-member update', () => {
  let groupDb: Kysely<GroupDatabase>
  let app: Express

  beforeEach(async () => {
    const testGroup = await createTestGroupDb()
    groupDb = testGroup.db
    await seedMember(groupDb, CALLER_DID, 'member')
    // Seed a record authored by a different user
    await seedAuthorship(groupDb, RECORD_URI, OTHER_AUTHOR, COLLECTION)
    const { ctx } = await createTestContext({
      groupDbs: { get: () => groupDb, getRaw: () => testGroup.raw, migrateGroup: async () => {}, destroyAll: async () => {} } as any,
    })
    app = createTestApp(ctx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('forbids a member from updating a record created by another member', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({
        repo: GROUP_DID,
        collection: COLLECTION,
        rkey: RKEY,
        record: { $type: COLLECTION, text: 'hello' },
      })

    expect(res.status).toBe(403)

    const auditRows = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .where('actor_did', '=', CALLER_DID)
      .where('action', '=', 'putAnyRecord')
      .where('result', '=', 'denied')
      .execute()

    expect(auditRows).toHaveLength(1)
  })
})
