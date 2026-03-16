import { describe, it, expect, beforeEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { AuditLogger } from '../src/audit.js'

describe('AuditLogger', () => {
  let groupDb: Kysely<GroupDatabase>
  let audit: AuditLogger

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    audit = new AuditLogger()
  })

  it('logs action with all fields', async () => {
    await audit.log(groupDb, 'did:plc:actor', 'createRecord', 'permitted', {
      collection: 'app.bsky.feed.post', rkey: 'abc', extra: 'data',
    }, 'jti-1')

    const rows = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_did).toBe('did:plc:actor')
    expect(rows[0].action).toBe('createRecord')
    expect(rows[0].result).toBe('permitted')
    expect(rows[0].collection).toBe('app.bsky.feed.post')
    expect(rows[0].rkey).toBe('abc')
    expect(rows[0].jti).toBe('jti-1')
    expect(JSON.parse(rows[0].detail!)).toMatchObject({ extra: 'data' })
  })

  it('logs without detail (null fields)', async () => {
    await audit.log(groupDb, 'did:plc:actor', 'member.add', 'denied')

    const rows = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(rows[0].detail).toBeNull()
    expect(rows[0].collection).toBeNull()
    expect(rows[0].rkey).toBeNull()
    expect(rows[0].jti).toBeNull()
  })

  it('extracts collection and rkey from detail', async () => {
    await audit.log(groupDb, 'did:plc:actor', 'createRecord', 'permitted', {
      collection: 'x', rkey: 'y', extra: 'z',
    })

    const rows = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(rows[0].collection).toBe('x')
    expect(rows[0].rkey).toBe('y')
    expect(JSON.parse(rows[0].detail!).extra).toBe('z')
  })

  it('detail serialized as JSON string', async () => {
    await audit.log(groupDb, 'did:plc:actor', 'member.add', 'permitted', {
      memberDid: 'did:plc:new', role: 'member',
    })

    const rows = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(JSON.parse(rows[0].detail!)).toEqual({ memberDid: 'did:plc:new', role: 'member' })
  })

  it('jti is optional', async () => {
    await audit.log(groupDb, 'did:plc:actor', 'createRecord', 'permitted', { collection: 'x' })

    const rows = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(rows[0].jti).toBeNull()
  })
})
