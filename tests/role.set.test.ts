import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { createTestContext, seedMember, createTestApp, mockAuth } from './helpers/mock-server.js'
import roleSetHandler from '../src/api/role/set.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('role.set', () => {
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    // createTestContext mock auth always returns callerDid = 'did:plc:testuser'
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const { ctx } = await createTestContext({
      groupDbs: { get: () => groupDb, migrateGroup: async () => {}, destroyAll: async () => {} } as any,
    })
    app = createTestApp(ctx, (server, appCtx) => {
      roleSetHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('promotes member to admin', async () => {
    await seedMember(groupDb, 'did:plc:member1', 'member')

    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:member1', role: 'admin' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ memberDid: 'did:plc:member1', role: 'admin' })
  })

  it('demotes admin to member', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')

    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:admin1', role: 'member' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ memberDid: 'did:plc:admin1', role: 'member' })
  })

  it('setting same role is a no-op success', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:admin1', role: 'admin' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('admin')
  })

  // ---------------------------------------------------------------------------
  // Owner role is immutable via role.set
  // ---------------------------------------------------------------------------

  it('rejects changing owner role with CannotModifyOwner', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:testuser', role: 'admin' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('CannotModifyOwner')
  })

  it('rejects promoting to owner with CannotPromoteToOwner', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')

    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:admin1', role: 'owner' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('CannotPromoteToOwner')
  })

  // ---------------------------------------------------------------------------
  // Standard guards
  // ---------------------------------------------------------------------------

  it('rejects role change for unknown member with MemberNotFound', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:nobody', role: 'member' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('MemberNotFound')
  })

  it('rejects invalid role with InvalidRole', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:testuser', role: 'superadmin' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidRole')
  })

  it('audit log records previousRole and newRole', async () => {
    await seedMember(groupDb, 'did:plc:target', 'member')
    await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:target', role: 'admin' })

    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.previousRole).toBe('member')
    expect(detail.newRole).toBe('admin')
    expect(detail.memberDid).toBe('did:plc:target')
  })
})
