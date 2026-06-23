/**
 * Handler-level tests: an API key with the right repo:/blob: scope can perform
 * PDS-repo writes; an under-scoped key is denied; and the RBAC role check still
 * applies underneath (own-vs-any follows the issuing owner's role, since repo:
 * scopes have no ownership axis).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import {
  createTestContext,
  seedMember,
  seedAuthorship,
  createTestApp,
} from './helpers/mock-server.js'
import createRecordHandler from '../src/api/repo/createRecord.js'
import deleteRecordHandler from '../src/api/repo/deleteRecord.js'
import uploadBlobHandler from '../src/api/repo/uploadBlob.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const GROUP = 'did:plc:testgroup'
const POST = 'app.bsky.feed.post'

/** An AuthVerifier mock that authenticates every call as an apiKey principal. */
function apiKeyAuth(scopes: string[], callerDid = 'did:plc:owner') {
  return {
    verifyServiceAuth: async () => ({ iss: callerDid }),
    resolveRepoToGroup: async () => GROUP,
    xrpcAuth() {
      return async () => ({
        credentials: {
          callerDid,
          groupDid: GROUP,
          legacyAud: false,
          authKind: 'apiKey' as const,
          scopes,
          apiKeyRef: 'ref1',
        },
      })
    },
    xrpcServiceAuth() {
      return async () => ({ credentials: { callerDid } })
    },
  } as unknown as AppContext['authVerifier']
}

const feedPost = () => ({
  repo: GROUP,
  collection: POST,
  record: { $type: POST, text: 'hi', createdAt: '2026-01-01T00:00:00.000Z' },
})

describe('API-key writes — createRecord', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:owner', 'owner')
  })

  function app() {
    return createTestApp(ctx, (s, c) => createRecordHandler(s, c))
  }

  it('allows createRecord with a repo: create scope for that collection', async () => {
    ctx.authVerifier = apiKeyAuth([`repo:${POST}?action=create`])
    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.createRecord?repo=${GROUP}`)
      .send(feedPost())
    expect(res.status).toBe(200)
  })

  it('denies createRecord when the scope is for a different collection', async () => {
    ctx.authVerifier = apiKeyAuth(['repo:app.bsky.actor.profile?action=create'])
    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.createRecord?repo=${GROUP}`)
      .send(feedPost())
    expect(res.status).toBe(403)
  })

  it('denies createRecord when the key only has a read (rpc:) scope', async () => {
    ctx.authVerifier = apiKeyAuth([
      'rpc:app.certified.group.member.list?aud=did:web:test.example.com%23certified_group_service',
    ])
    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.createRecord?repo=${GROUP}`)
      .send(feedPost())
    expect(res.status).toBe(403)
  })
})

describe('API-key writes — role still enforced under the scope (own vs any)', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
  })

  function app() {
    return createTestApp(ctx, (s, c) => deleteRecordHandler(s, c))
  }

  const delBody = (rkey: string) => ({ repo: GROUP, collection: POST, rkey })

  it('a member-issued key can delete its own record (deleteOwnRecord)', async () => {
    await seedMember(groupDb, 'did:plc:member', 'member')
    const uri = `at://${GROUP}/${POST}/self1`
    await seedAuthorship(groupDb, uri, 'did:plc:member', POST)
    ctx.authVerifier = apiKeyAuth([`repo:${POST}?action=delete`], 'did:plc:member')
    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.deleteRecord?repo=${GROUP}`)
      .send(delBody('self1'))
    expect(res.status).toBe(200)
  })

  it("a member-issued key CANNOT delete another member's record (deleteAnyRecord needs admin)", async () => {
    await seedMember(groupDb, 'did:plc:member', 'member')
    const uri = `at://${GROUP}/${POST}/other1`
    await seedAuthorship(groupDb, uri, 'did:plc:someoneelse', POST)
    // Scope DOES grant delete on the collection, but the role check blocks
    // deleting a record the member didn't author.
    ctx.authVerifier = apiKeyAuth([`repo:${POST}?action=delete`], 'did:plc:member')
    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.deleteRecord?repo=${GROUP}`)
      .send(delBody('other1'))
    expect(res.status).toBe(403)
  })
})

describe('API-key writes — uploadBlob (blob: scope)', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:owner', 'owner')
  })

  function app() {
    return createTestApp(ctx, (s, c) => uploadBlobHandler(s, c))
  }

  async function upload(contentType: string) {
    return request(app())
      .post(`/xrpc/com.atproto.repo.uploadBlob?repo=${GROUP}`)
      .set('Content-Type', contentType)
      .send(Buffer.from([1, 2, 3]))
  }

  it('allows uploadBlob when a blob: scope covers the content-type', async () => {
    ctx.authVerifier = apiKeyAuth(['blob:image/*'])
    const res = await upload('image/png')
    expect(res.status).toBe(200)
  })

  it('denies uploadBlob when the blob: scope does not cover the content-type', async () => {
    ctx.authVerifier = apiKeyAuth(['blob:image/*'])
    const res = await upload('video/mp4')
    expect(res.status).toBe(403)
  })

  it('denies uploadBlob when the key has no blob: scope', async () => {
    ctx.authVerifier = apiKeyAuth([`repo:${POST}?action=create`])
    const res = await upload('image/png')
    expect(res.status).toBe(403)
  })
})
