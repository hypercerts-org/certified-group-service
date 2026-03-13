import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { buildTestServer, seedMember, seedAuthorship } from './helpers/mock-server.js'
import putRecordHandler from '../src/api/repo/putRecord.js'

async function putRecord(url: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
  const resBody = await res.json()
  return { status: res.status, body: resBody }
}

// The mock auth verifier always returns callerDid='did:plc:testuser', groupDid='did:plc:testgroup'
const GROUP_DID = 'did:plc:testgroup'
const CALLER_DID = 'did:plc:testuser'
const OTHER_AUTHOR = 'did:plc:other-author'
const COLLECTION = 'app.bsky.feed.post'
const RKEY = 'somekey'
const RECORD_URI = `at://${GROUP_DID}/${COLLECTION}/${RKEY}`

describe('putRecord — non-author rejection audit logging', () => {
  let groupDb: Kysely<GroupDatabase>
  let url: string
  let close: () => Promise<void>

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    await seedMember(groupDb, CALLER_DID, 'member')
    // Seed a record authored by a different user
    await seedAuthorship(groupDb, RECORD_URI, OTHER_AUTHOR, COLLECTION)
    ;({ url, close } = await buildTestServer(groupDb, putRecordHandler))
  })

  afterEach(async () => {
    await close()
    await groupDb.destroy()
  })

  it('returns 403 and writes a denied audit row when caller is not the record author', async () => {
    const { status } = await putRecord(url, {
      repo: GROUP_DID,
      collection: COLLECTION,
      rkey: RKEY,
      record: { $type: COLLECTION, text: 'hello' },
    })

    expect(status).toBe(403)

    const auditRows = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .where('actor_did', '=', CALLER_DID)
      .where('action', '=', 'putOwnRecord')
      .where('result', '=', 'denied')
      .execute()

    expect(auditRows).toHaveLength(1)
  })
})
