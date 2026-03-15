import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { createTestContext, seedMember, seedAuthorship, silentLogger } from './helpers/mock-server.js'
import putRecordHandler from '../src/api/repo/putRecord.js'
import { xrpcErrorHandler } from '../src/api/error-handler.js'

// The mock auth verifier always returns callerDid='did:plc:testuser', groupDid='did:plc:testgroup'
const GROUP_DID = 'did:plc:testgroup'
const CALLER_DID = 'did:plc:testuser'
const OTHER_AUTHOR = 'did:plc:other-author'
const COLLECTION = 'app.bsky.feed.post'
const RKEY = 'somekey'
const RECORD_URI = `at://${GROUP_DID}/${COLLECTION}/${RKEY}`

describe('putRecord — cross-member update', () => {
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    await seedMember(groupDb, CALLER_DID, 'member')
    // Seed a record authored by a different user
    await seedAuthorship(groupDb, RECORD_URI, OTHER_AUTHOR, COLLECTION)
    const { ctx } = await createTestContext({
      groupDbs: { get: () => groupDb, migrateGroup: async () => {}, destroyAll: async () => {} } as any,
    })
    app = express()
    app.use(express.json())
    putRecordHandler(app, ctx)
    app.use(xrpcErrorHandler(silentLogger as any))
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('allows a member to update a record created by another member', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({
        repo: GROUP_DID,
        collection: COLLECTION,
        rkey: RKEY,
        record: { $type: COLLECTION, text: 'hello' },
      })

    expect(res.status).toBe(200)

    const auditRows = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .where('actor_did', '=', CALLER_DID)
      .where('action', '=', 'putAnyRecord')
      .where('result', '=', 'permitted')
      .execute()

    expect(auditRows).toHaveLength(1)
  })
})
