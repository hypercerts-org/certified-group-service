import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, seedAuthorship, silentLogger } from './helpers/mock-server.js'
import createRecordHandler from '../src/api/repo/createRecord.js'
import deleteRecordHandler from '../src/api/repo/deleteRecord.js'
import putRecordHandler from '../src/api/repo/putRecord.js'
import { xrpcErrorHandler } from '../src/api/error-handler.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

function createApp(ctx: AppContext) {
  const app = express()
  app.use(express.json())
  createRecordHandler(app, ctx)
  deleteRecordHandler(app, ctx)
  putRecordHandler(app, ctx)
  app.use(xrpcErrorHandler(silentLogger as any))
  return app
}

describe('createRecord', () => {
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
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:stranger', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', record: {} })
    expect(res.status).toBe(401)
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
})

describe('deleteRecord', () => {
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
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:admin1', aud: 'did:plc:testgroup' }) } as any })
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/abc', 'did:plc:other', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'abc' })
    expect(res.status).toBe(200)
  })
})

describe('putRecord', () => {
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

  it('profile update requires admin — member gets 403', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.actor.profile', rkey: 'self', record: {} })
    expect(res.status).toBe(403)
  })

  it('admin can update profile', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    app = createApp({ ...ctx, authVerifier: { verify: async () => ({ iss: 'did:plc:admin1', aud: 'did:plc:testgroup' }) } as any })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.actor.profile', rkey: 'self', record: {} })
    expect(res.status).toBe(200)
  })

  it('cannot update record authored by others', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:testgroup/app.bsky.feed.post/xyz', 'did:plc:other', 'app.bsky.feed.post')
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'xyz', record: {} })
    expect(res.status).toBe(403)
  })

  it('new record via putRecord treated as createRecord permission', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: 'did:plc:testgroup', collection: 'app.bsky.feed.post', rkey: 'new1', record: {} })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(1)
  })
})
