import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AtpAgent, type Agent } from '@atproto/api'
import type { Express } from 'express'
import request from 'supertest'
import {
  createTestContext,
  createTestApp,
  mockAuth,
  seedMember,
  seedAuthorship,
} from './helpers/mock-server.js'
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
      .send({
        repo: 'did:plc:testgroup',
        collection: 'app.bsky.feed.post',
        record: { text: 'hello' },
      })
    expect(res.status).toBe(200)
    expect(res.body.uri).toBeDefined()
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(1)
    expect(authors[0].author_did).toBe('did:plc:testuser')
  })

  it('rejects an unregistered repo (resolves to no known group)', async () => {
    // Post-#27: `repo` is the group selector, not a cross-check against `aud`.
    // A repo that names no registered group is rejected at resolution, not as a
    // 403 "mismatch".
    const res = await request(app).post('/xrpc/com.atproto.repo.createRecord').send({
      repo: 'did:plc:wrong',
      collection: 'app.bsky.feed.post',
      record: {},
    })
    expect(res.status).toBe(401)
  })

  it('rejects non-members', async () => {
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:stranger') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      createRecordHandler(server, appCtx)
      deleteRecordHandler(server, appCtx)
    })
    const res = await request(app).post('/xrpc/com.atproto.repo.createRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      record: {},
    })
    expect(res.status).toBe(403)
  })

  it('audit logs permitted actions', async () => {
    await request(app).post('/xrpc/com.atproto.repo.createRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      record: {},
    })
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
    await request(app).post('/xrpc/com.atproto.repo.createRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      record: {},
    })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.reason).toBeDefined()
  })

  it('response includes uri and cid', async () => {
    const res = await request(app).post('/xrpc/com.atproto.repo.createRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      record: {},
    })
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
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/abc',
      'did:plc:testuser',
      'app.bsky.feed.post',
    )
    const res = await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(0)
  })

  it('rejects member deleting others records', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/abc',
      'did:plc:other',
      'app.bsky.feed.post',
    )
    const res = await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    expect(res.status).toBe(403)
  })

  it('allows admin to delete any record', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      deleteRecordHandler(server, appCtx)
    })
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/abc',
      'did:plc:other',
      'app.bsky.feed.post',
    )
    const res = await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    expect(res.status).toBe(200)
  })

  it('audit logs denied delete with reason', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/abc',
      'did:plc:other',
      'app.bsky.feed.post',
    )
    await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
    const detail = JSON.parse(logs[0].detail!)
    expect(detail.reason).toBeDefined()
  })

  it('rejects an unregistered repo on delete (resolves to no known group)', async () => {
    const res = await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:wrong',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    expect(res.status).toBe(401)
  })

  it('authorship cleaned up after successful delete', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/abc',
      'did:plc:testuser',
      'app.bsky.feed.post',
    )
    await request(app).post('/xrpc/com.atproto.repo.deleteRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'abc',
    })
    const authors = await groupDb
      .selectFrom('group_record_authors')
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

  function appWithLocalPds(
    respond: (body: Record<string, unknown>) => Response = () =>
      new Response(
        JSON.stringify({
          uri: 'at://did:plc:testgroup/app.bsky.feed.post/abc123',
          cid: 'bafyreiclp443lavogvhj3d2ob2cxbfuscni2k5jk7bebjzg7khl3esabwq',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    appCtx: AppContext = ctx,
  ) {
    const sentBodies: Record<string, unknown>[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const outgoingRequest = input instanceof Request ? input : new Request(input, init)
      const body = JSON.parse(await outgoingRequest.clone().text()) as Record<string, unknown>
      sentBodies.push(body)
      return respond(body)
    }
    const agent = new AtpAgent({ service: 'https://pds.invalid', fetch })
    const pdsAgents = {
      withAgent: async <T>(_groupDid: string, run: (agent: Agent) => Promise<T>) => run(agent),
    }
    const testCtx = {
      ...appCtx,
      pdsAgents: pdsAgents as unknown as AppContext['pdsAgents'],
    }

    return {
      app: createTestApp(testCtx, (server, registeredCtx) =>
        putRecordHandler(server, registeredCtx),
      ),
      sentBodies,
    }
  }

  it('profile update requires admin — member gets 403', async () => {
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: {},
    })
    expect(res.status).toBe(403)
  })

  it('admin can update profile', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: {},
    })
    expect(res.status).toBe(200)
  })

  it('member cannot update record authored by others', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/xyz',
      'did:plc:other',
      'app.bsky.feed.post',
    )
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'xyz',
      record: {},
    })
    expect(res.status).toBe(403)
  })

  it('admin can update record authored by others', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/xyz',
      'did:plc:other',
      'app.bsky.feed.post',
    )
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'xyz',
      record: {},
    })
    expect(res.status).toBe(200)

    const auditRows = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .where('actor_did', '=', 'did:plc:admin1')
      .where('action', '=', 'putAnyRecord')
      .where('result', '=', 'permitted')
      .execute()
    expect(auditRows).toHaveLength(1)
  })

  it.each(['com.atproto.repo.putRecord', 'app.certified.group.repo.putRecord'])(
    'forces a create-only condition for untracked writes through %s',
    async (method) => {
      const recordCid = 'bafyreiclp443lavogvhj3d2ob2cxbfuscni2k5jk7bebjzg7khl3esabwq'
      const commitCid = 'bafyreibdrw2ps37hvyuahejlzuhe3zqcy4hpf7ark2fuyffglaqpr3ekxu'
      const { app: localApp, sentBodies } = appWithLocalPds()
      const res = await request(localApp).post(`/xrpc/${method}`).send({
        repo: 'did:plc:testgroup',
        collection: 'app.bsky.feed.post',
        rkey: 'untracked1',
        record: {},
        swapRecord: recordCid,
        swapCommit: commitCid,
      })

      expect(res.status).toBe(200)
      expect(sentBodies).toHaveLength(1)
      expect(sentBodies[0].swapRecord).toBeNull()
      expect(sentBodies[0].swapCommit).toBe(commitCid)
    },
  )

  it('does not track authorship or audit permission when the upstream conditional write fails', async () => {
    const { app: localApp, sentBodies } = appWithLocalPds(
      () =>
        new Response(
          JSON.stringify({ error: 'InvalidSwap', message: 'conditional write rejected' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )
    const res = await request(localApp).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'untracked2',
      record: {},
      swapRecord: 'bafy-caller-condition',
    })

    expect(res.status).toBe(400)
    expect(sentBodies[0].swapRecord).toBeNull()
    expect(await groupDb.selectFrom('group_record_authors').selectAll().execute()).toEqual([])
    expect(await groupDb.selectFrom('group_audit_log').selectAll().execute()).toEqual([])
  })

  it('preserves caller conditions for an untracked write authorized by putAnyRecord', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const adminCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    const { app: localApp, sentBodies } = appWithLocalPds(undefined, adminCtx)
    const res = await request(localApp).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'untracked3',
      record: {},
      swapRecord: 'bafy-caller-condition',
      swapCommit: 'bafy-caller-commit',
    })

    expect(res.status).toBe(200)
    expect(sentBodies[0].swapRecord).toBe('bafy-caller-condition')
    expect(sentBodies[0].swapCommit).toBe('bafy-caller-commit')
    const auditRows = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .where('actor_did', '=', 'did:plc:admin1')
      .execute()
    expect(auditRows).toEqual([{ action: 'putAnyRecord', result: 'permitted' }])
  })

  it('preserves caller conditions for a record authored by the caller', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/owned1',
      'did:plc:testuser',
      'app.bsky.feed.post',
    )
    const { app: localApp, sentBodies } = appWithLocalPds()
    const res = await request(localApp).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'owned1',
      record: {},
      swapRecord: 'bafy-caller-condition',
      swapCommit: 'bafy-caller-commit',
    })

    expect(res.status).toBe(200)
    expect(sentBodies[0].swapRecord).toBe('bafy-caller-condition')
    expect(sentBodies[0].swapCommit).toBe('bafy-caller-commit')
  })

  it('preserves caller conditions for profile updates', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const adminCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    const { app: localApp, sentBodies } = appWithLocalPds(undefined, adminCtx)
    const res = await request(localApp).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: {},
      swapRecord: 'bafy-caller-condition',
      swapCommit: 'bafy-caller-commit',
    })

    expect(res.status).toBe(200)
    expect(sentBodies[0].swapRecord).toBe('bafy-caller-condition')
    expect(sentBodies[0].swapCommit).toBe('bafy-caller-commit')
  })

  it('new record via putRecord treated as createRecord permission', async () => {
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'new1',
      record: {},
    })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toMatchObject([
      { author_did: 'did:plc:testuser', collection: 'app.bsky.feed.post' },
    ])
    const audits = await groupDb
      .selectFrom('group_audit_log')
      .select(['action', 'result'])
      .execute()
    expect(audits).toEqual([{ action: 'createRecord', result: 'permitted' }])
  })

  it('profile update skips authorship tracking', async () => {
    await seedMember(groupDb, 'did:plc:admin1', 'admin')
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:admin1') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      putRecordHandler(server, appCtx)
    })
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: {},
    })
    expect(res.status).toBe(200)
    const authors = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(authors).toHaveLength(0)
  })

  it('author can update own record via putRecord', async () => {
    await seedAuthorship(
      groupDb,
      'at://did:plc:testgroup/app.bsky.feed.post/xyz',
      'did:plc:testuser',
      'app.bsky.feed.post',
    )
    const res = await request(app).post('/xrpc/com.atproto.repo.putRecord').send({
      repo: 'did:plc:testgroup',
      collection: 'app.bsky.feed.post',
      rkey: 'xyz',
      record: {},
    })
    expect(res.status).toBe(200)
  })
})
