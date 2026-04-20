import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Express } from 'express'
import request from 'supertest'
import { createTestContext, createTestApp, mockAuth, seedMember, seedAuthorship } from './helpers/mock-server.js'
import createRecordHandler from '../src/api/repo/createRecord.js'
import deleteRecordHandler from '../src/api/repo/deleteRecord.js'
import putRecordHandler from '../src/api/repo/putRecord.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

describe('createRecord', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createTestApp(ctx, (server, appCtx) => {
      createRecordHandler(server, appCtx)
      deleteRecordHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('creates record and tracks authorship', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: { text: 'hello' } })
    expect(res.status).toBe(200)
    expect(res.body.uri).toBeDefined()
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(1)
    expect(authors[0].author_did).toBe('did:plc:testuser')
  })

  it('rejects repo DID mismatch', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:wrong', collection: 'app.bsky.feed.post', record: {} })
    expect(res.status).toBe(403)
  })

  it('rejects non-members', async () => {
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:stranger') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      createRecordHandler(server, appCtx)
      deleteRecordHandler(server, appCtx)
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: {} })
    expect(res.status).toBe(403)
  })

  it('audit logs permitted actions', async () => {
    await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: {} })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('createRecord')
    expect(logs[0].result).toBe('permitted')
  })

  it('audit logs denied actions with reason', async () => {
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:stranger') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      createRecordHandler(server, appCtx)
      deleteRecordHandler(server, appCtx)
    })
    await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: {} })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.reason).toBeDefined()
  })

  it('response includes uri and cid', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: {} })
    expect(res.status).toBe(200)
    expect(res.body.uri).toBeDefined()
    expect(res.body.cid).toBeDefined()
  })
})

describe('deleteRecord', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createTestApp(ctx, (server, appCtx) => {
      deleteRecordHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('allows author to delete own record', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:testuser', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(0)
  })

  it('rejects member deleting others records', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:other', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    expect(res.status).toBe(403)
  })

  it('allows admin to delete any record', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      deleteRecordHandler(server, appCtx)
    })
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:other', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    expect(res.status).toBe(200)
  })

  it('audit logs denied delete with reason', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:other', 'app.bsky.feed.post')
    await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.reason).toBeDefined()
  })

  it('repo DID mismatch returns 403', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:wrong', collection: 'app.bsky.feed.post', rkey: 'abc' })
    expect(res.status).toBe(403)
  })

  it('authorship cleaned up after successful delete', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:testuser', 'app.bsky.feed.post')
    await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    const authors = await groupDb.selectFrom('group_record_authors')
      .selectAll()
      .where('record_uri', '=', 'at://did:plc:testgroup/app.bsky.feed.post/abc')
      .execute()
    expect(authors).toHaveLength(0)
  })
})

describe('putRecord', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createTestApp(ctx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('profile update requires admin — member gets 403', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.actor.profile', rkey: 'self', record: {} })
    expect(res.status).toBe(403)
  })

  it('admin can update profile', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.actor.profile', rkey: 'self', record: {} })
    expect(res.status).toBe(200)
  })

  it('member cannot update record authored by others', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/xyz', 'did:plc:other', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'xyz', record: {} })
    expect(res.status).toBe(403)
  })

  it('admin can update record authored by others', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/xyz', 'did:plc:other', 'app.bsky.feed.post')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'xyz', record: {} })
    expect(res.status).toBe(200)
  })

  it('new record via putRecord treated as createRecord permission', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'new1', record: {} })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(1)
  })

  it('profile update skips authorship tracking', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.actor.profile', rkey: 'self', record: {} })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(0)
  })

  it('author can update own record via putRecord', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/xyz', 'did:plc:testuser', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'xyz', record: {} })
    expect(res.status).toBe(200)
  })
})
