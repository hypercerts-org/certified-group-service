/**
 * Request-level coverage for the #27 group-targeting change: both the legacy
 * `aud = groupDid` overload and the new `aud = serviceDid` + explicit `repo`
 * form must work, across a query (member.list) and a procedure (createRecord).
 * Also asserts the deprecation signal fires only on the legacy path.
 *
 * The verifier's own unit tests (tests/verifier.test.ts) cover aud/repo
 * resolution in isolation; these go through the real handlers via the two mock
 * auth verifiers (mockAuth = legacy, mockAuthNewPath = new).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Express } from 'express'
import request from 'supertest'
import {
  createTestContext,
  createTestApp,
  mockAuth,
  mockAuthNewPath,
  seedMember,
} from './helpers/mock-server.js'
import memberListHandler from '../src/api/member/list.js'
import createRecordHandler from '../src/api/repo/createRecord.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const GROUP = 'did:plc:testgroup'
const MEMBER_LIST = '/xrpc/app.certified.group.member.list'
const CREATE_RECORD = '/xrpc/com.atproto.repo.createRecord'

function build(ctx: AppContext): Express {
  return createTestApp(ctx, (server, appCtx) => {
    memberListHandler(server, appCtx)
    createRecordHandler(server, appCtx)
  })
}

describe('group targeting — legacy aud vs new repo (#27)', () => {
  let baseCtx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    baseCtx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:caller', 'member')
    // A second member with a distinct DID, so the two legacy-path warn
    // assertions don't collide on the per-caller-DID warn rate limiter.
    await seedMember(groupDb, 'did:plc:caller2', 'member')
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  // --- Query method: member.list ---

  it('legacy: member.list with aud=groupDid (no repo) works and signals deprecation', async () => {
    const warn = vi.fn()
    const ctx = {
      ...baseCtx,
      authVerifier: mockAuth('did:plc:caller'),
      logger: { ...baseCtx.logger, warn } as any,
    }
    const res = await request(build(ctx)).get(MEMBER_LIST)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.members)).toBe(true)
    // RFC 8594 deprecation signalling on the legacy path
    expect(res.headers['deprecation']).toBe('true')
    expect(res.headers['link']).toContain('rel="deprecation"')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('new: member.list with ?repo=<groupDid> and aud=serviceDid works, no deprecation', async () => {
    const warn = vi.fn()
    const ctx = {
      ...baseCtx,
      authVerifier: mockAuthNewPath('did:plc:caller'),
      logger: { ...baseCtx.logger, warn } as any,
    }
    const res = await request(build(ctx)).get(`${MEMBER_LIST}?repo=${GROUP}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.members)).toBe(true)
    expect(res.headers['deprecation']).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('new: member.list with a handle in ?repo is resolved to the group', async () => {
    const ctx = { ...baseCtx, authVerifier: mockAuthNewPath('did:plc:caller') }
    const res = await request(build(ctx)).get(`${MEMBER_LIST}?repo=group.example.com`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.members)).toBe(true)
  })

  it('new: member.list with aud=serviceDid but no repo is a 400 (no group named)', async () => {
    const ctx = { ...baseCtx, authVerifier: mockAuthNewPath('did:plc:caller') }
    const res = await request(build(ctx)).get(MEMBER_LIST)
    expect(res.status).toBe(400)
  })

  // --- Procedure: createRecord (repo in the body) ---

  it('legacy: createRecord with body repo=groupDid (aud overload) works + deprecation', async () => {
    const warn = vi.fn()
    const ctx = {
      ...baseCtx,
      // distinct caller so the warn rate limiter (keyed per caller DID) doesn't
      // suppress this warn after the member.list legacy test already warned.
      authVerifier: mockAuth('did:plc:caller2'),
      logger: { ...baseCtx.logger, warn } as any,
    }
    const res = await request(build(ctx))
      .post(CREATE_RECORD)
      .send({ repo: GROUP, collection: 'app.bsky.feed.post', record: { text: 'hi' } })
    expect(res.status).toBe(200)
    expect(res.headers['deprecation']).toBe('true')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('new: createRecord with aud=serviceDid resolves the group from the body repo, no deprecation', async () => {
    const warn = vi.fn()
    const ctx = {
      ...baseCtx,
      authVerifier: mockAuthNewPath('did:plc:caller'),
      logger: { ...baseCtx.logger, warn } as any,
    }
    const res = await request(build(ctx))
      .post(CREATE_RECORD)
      .send({ repo: GROUP, collection: 'app.bsky.feed.post', record: { text: 'hi' } })
    expect(res.status).toBe(200)
    expect(res.headers['deprecation']).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('new: createRecord with a handle in the body repo is resolved to the group', async () => {
    const ctx = { ...baseCtx, authVerifier: mockAuthNewPath('did:plc:caller') }
    const res = await request(build(ctx))
      .post(CREATE_RECORD)
      .send({ repo: 'group.example.com', collection: 'app.bsky.feed.post', record: { text: 'hi' } })
    expect(res.status).toBe(200)
  })

  it('new: createRecord with aud=serviceDid but no body repo is a 400 (no group named)', async () => {
    const ctx = { ...baseCtx, authVerifier: mockAuthNewPath('did:plc:caller') }
    const res = await request(build(ctx))
      .post(CREATE_RECORD)
      .send({ collection: 'app.bsky.feed.post', record: { text: 'hi' } })
    expect(res.status).toBe(400)
  })
})
