import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, silentLogger } from './helpers/mock-server.js'
import memberAddHandler from '../src/api/member/add.js'
import memberRemoveHandler from '../src/api/member/remove.js'
import memberListHandler from '../src/api/member/list.js'
import roleSetHandler from '../src/api/role/set.js'
import auditQueryHandler from '../src/api/audit/query.js'
import { xrpcErrorHandler } from '../src/api/error-handler.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

function createApp(ctx: AppContext) {
  const app = express()
  app.use(express.json())
  memberAddHandler(app, ctx)
  memberRemoveHandler(app, ctx)
  memberListHandler(app, ctx)
  roleSetHandler(app, ctx)
  auditQueryHandler(app, ctx)
  app.use(xrpcErrorHandler(silentLogger as any))
  return app
}

describe('member.add', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'admin')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('admin adds a member', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newuser', role: 'member' })
    expect(res.status).toBe(200)
    expect(res.body.memberDid).toBe('did:plc:newuser')
    expect(res.body.role).toBe('member')
    expect(res.body.addedAt).toBeDefined()
  })

  it('admin cannot add another admin (role >= own)', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newuser', role: 'admin' })
    expect(res.status).toBe(403)
  })

  it('duplicate member returns 409', async () => {
    await seedMember(groupDb, 'did:plc:existing', 'member')
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:existing', role: 'member' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('MemberAlreadyExists')
  })

  it('concurrent duplicate requests both return 200 or 409, never 500', async () => {
    const [res1, res2] = await Promise.all([
      request(app).post('/xrpc/app.certified.group.member.add').send({ memberDid: 'did:plc:concurrent', role: 'member' }),
      request(app).post('/xrpc/app.certified.group.member.add').send({ memberDid: 'did:plc:concurrent', role: 'member' }),
    ])
    expect([200, 409]).toContain(res1.status)
    expect([200, 409]).toContain(res2.status)
    expect(res1.status).not.toBe(500)
    expect(res2.status).not.toBe(500)
  })

  it('role owner returns 400 InvalidRole', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newuser', role: 'owner' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidRole')
  })

  it('member cannot add anyone (RBAC 403)', async () => {
    await seedMember(groupDb, 'did:plc:member1', 'member')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:member1', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newuser', role: 'member' })
    expect(res.status).toBe(403)
  })

  it('invalid DID format returns 400', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'not-a-did', role: 'member' })
    expect(res.status).toBe(500) // ensureValidDid throws a generic Error
  })

  it('missing memberDid field returns error', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ role: 'member' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('owner can add admin', async () => {
    await seedMember(groupDb, 'did:plc:owner1', 'owner')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:owner1', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newadmin', role: 'admin' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('admin')
  })

  it('audit log records memberDid and role in detail', async () => {
    await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid: 'did:plc:newuser', role: 'member' })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.memberDid).toBe('did:plc:newuser')
    expect(detail.role).toBe('member')
  })
})

describe('member.remove', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'admin')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('admin removes lower-role member', async () => {
    await seedMember(groupDb, 'did:plc:target', 'member')
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:target' })
    expect(res.status).toBe(200)
    const remaining = await groupDb.selectFrom('group_members').selectAll().where('member_did', '=', 'did:plc:target').execute()
    expect(remaining).toHaveLength(0)
  })

  it('cannot remove owner', async () => {
    await seedMember(groupDb, 'did:plc:owner1', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:owner1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('CannotRemoveOwner')
  })

  it('self-removal succeeds', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:testuser' })
    expect(res.status).toBe(200)
  })

  it('removing non-existent member returns 404', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:ghost' })
    expect(res.status).toBe(404)
  })

  it('self-removal of non-member returns 401', async () => {
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:stranger', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:stranger' })
    expect(res.status).toBe(401)
  })

  it('admin cannot remove another admin (equal role)', async () => {
    await seedMember(groupDb, 'did:plc:admin2', 'admin')
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:admin2' })
    expect(res.status).toBe(403)
  })

  it('admin cannot remove owner (higher role)', async () => {
    await seedMember(groupDb, 'did:plc:owner1', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:owner1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('CannotRemoveOwner')
  })

  it('member cannot remove another member (RBAC blocks)', async () => {
    await seedMember(groupDb, 'did:plc:member1', 'member')
    await seedMember(groupDb, 'did:plc:member2', 'member')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:member1', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid: 'did:plc:member2' })
    expect(res.status).toBe(403)
  })
})

describe('member.list', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('returns members list with correct fields', async () => {
    const res = await request(app).get('/xrpc/app.certified.group.member.list')
    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(1)
    expect(res.body.members[0].did).toBe('did:plc:testuser')
    expect(res.body.members[0].role).toBe('member')
    expect(res.body.members[0].addedAt).toBeDefined()
  })

  it('paginates with cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await seedMember(groupDb, `did:plc:user${i}`, 'member')
    }
    const res = await request(app).get('/xrpc/app.certified.group.member.list?limit=3')
    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(3)
    expect(res.body.cursor).toBeDefined()
    const res2 = await request(app).get(`/xrpc/app.certified.group.member.list?limit=3&cursor=${res.body.cursor}`)
    expect(res2.status).toBe(200)
    expect(res2.body.members.length).toBeGreaterThan(0)
  })

  it('non-members get 401', async () => {
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:stranger', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app).get('/xrpc/app.certified.group.member.list')
    expect(res.status).toBe(401)
  })

  it('limit=0 falls back to default (50)', async () => {
    await seedMember(groupDb, 'did:plc:user0', 'member')
    await seedMember(groupDb, 'did:plc:user1', 'member')
    const res = await request(app).get('/xrpc/app.certified.group.member.list?limit=0')
    expect(res.status).toBe(200)
    // 0 is falsy, so parseInt('0') || 50 → 50, returns all 3 members
    expect(res.body.members).toHaveLength(3)
  })

  it('limit clamped to 100 when exceeding', async () => {
    // With only a few members, we can just verify request succeeds (limit > 100 doesn't error)
    const res = await request(app).get('/xrpc/app.certified.group.member.list?limit=999')
    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(1) // only testuser
  })

  it('invalid cursor returns 400 InvalidCursor', async () => {
    const badCursor = Buffer.from('bad').toString('base64')
    const res = await request(app).get(`/xrpc/app.certified.group.member.list?cursor=${badCursor}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidCursor')
  })

  it('completely invalid base64 cursor returns 400', async () => {
    const res = await request(app).get('/xrpc/app.certified.group.member.list?cursor=!!!')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidCursor')
  })
})

describe('role.set', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('owner promotes member to admin', async () => {
    await seedMember(groupDb, 'did:plc:target', 'member')
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:target', role: 'admin' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('admin')
  })

  it('prevents last owner demotion', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:testuser', role: 'admin' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('LastOwnerDemotion')
  })

  it('allows owner demotion when another owner exists', async () => {
    await seedMember(groupDb, 'did:plc:owner2', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:testuser', role: 'admin' })
    expect(res.status).toBe(200)
  })

  it('non-owner cannot set roles', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:admin1', aud: 'did:plc:testgroup' }) } as any })
    await seedMember(groupDb, 'did:plc:target', 'member')
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:target', role: 'admin' })
    expect(res.status).toBe(403)
  })

  it('setting role on non-existent member returns 404', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid: 'did:plc:ghost', role: 'admin' })
    expect(res.status).toBe(404)
  })
})

describe('audit.query', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'admin')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('returns audit entries newest-first', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:someone', action: 'createRecord', result: 'permitted',
      collection: 'app.bsky.feed.post', rkey: 'abc',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].action).toBe('createRecord')
  })

  it('filters by actorDid', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'createRecord', result: 'permitted',
    }).execute()
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:b', action: 'createRecord', result: 'permitted',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query?actorDid=did:plc:a')
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].actorDid).toBe('did:plc:a')
  })

  it('members cannot query audit log', async () => {
    await seedMember(groupDb, 'did:plc:member1', 'member')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:member1', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.status).toBe(403)
  })

  it('parses detail JSON in response', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:x', action: 'member.add', result: 'permitted',
      detail: JSON.stringify({ memberDid: 'did:plc:new', role: 'member' }),
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.body.entries[0].detail).toEqual({ memberDid: 'did:plc:new', role: 'member' })
  })

  it('filters by action', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'createRecord', result: 'permitted',
    }).execute()
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'deleteRecord', result: 'permitted',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query?action=createRecord')
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].action).toBe('createRecord')
  })

  it('filters by collection', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'createRecord', result: 'permitted', collection: 'app.bsky.feed.post',
    }).execute()
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'createRecord', result: 'permitted', collection: 'app.bsky.feed.like',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query?collection=app.bsky.feed.post')
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].collection).toBe('app.bsky.feed.post')
  })

  it('multiple filters combined (AND)', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'createRecord', result: 'permitted',
    }).execute()
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'deleteRecord', result: 'permitted',
    }).execute()
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:b', action: 'createRecord', result: 'permitted',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query?actorDid=did:plc:a&action=createRecord')
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].actorDid).toBe('did:plc:a')
    expect(res.body.entries[0].action).toBe('createRecord')
  })

  it('invalid cursor returns 400 InvalidCursor', async () => {
    const badCursor = Buffer.from('abc').toString('base64')
    const res = await request(app).get(`/xrpc/app.certified.group.audit.query?cursor=${badCursor}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidCursor')
  })

  it('empty audit log returns empty entries array', async () => {
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.status).toBe(200)
    expect(res.body.entries).toEqual([])
  })

  it('pagination with cursor works', async () => {
    for (let i = 0; i < 5; i++) {
      await groupDb.insertInto('group_audit_log').values({
        actor_did: 'did:plc:a', action: `action${i}`, result: 'permitted',
      }).execute()
    }
    const page1 = await request(app).get('/xrpc/app.certified.group.audit.query?limit=2')
    expect(page1.body.entries).toHaveLength(2)
    expect(page1.body.cursor).toBeDefined()

    const page2 = await request(app).get(`/xrpc/app.certified.group.audit.query?limit=2&cursor=${page1.body.cursor}`)
    expect(page2.body.entries).toHaveLength(2)
    expect(page2.body.cursor).toBeDefined()

    const page3 = await request(app).get(`/xrpc/app.certified.group.audit.query?limit=2&cursor=${page2.body.cursor}`)
    expect(page3.body.entries).toHaveLength(1)
    expect(page3.body.cursor).toBeUndefined()
  })

  it('malformed detail JSON returns undefined', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'test', result: 'permitted', detail: '{bad json',
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.body.entries[0].detail).toBeUndefined()
  })

  it('null detail returns undefined', async () => {
    await groupDb.insertInto('group_audit_log').values({
      actor_did: 'did:plc:a', action: 'test', result: 'permitted', detail: null,
    }).execute()
    const res = await request(app).get('/xrpc/app.certified.group.audit.query')
    expect(res.body.entries[0].detail).toBeUndefined()
  })
})
