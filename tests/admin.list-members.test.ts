import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'
import { AuthVerifier } from '../src/auth/verifier.js'
import {
  createTestContext,
  createTestApp,
  seedMemberWithIndex,
  TEST_ADMIN_PASSWORD,
} from './helpers/mock-server.js'
import { registerXrpcMethods } from '../src/api/index.js'

const NSID = 'app.certified.group.admin.listMembers'
const GROUP = 'did:plc:testgroup'
const OWNER = 'did:plc:owner1'
const ADMIN = 'did:plc:admin1'
const MEMBER = 'did:plc:member1'

const basic = (user: string, pass: string): string =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

describe('admin.listMembers', () => {
  let groupDb: Kysely<GroupDatabase>
  let globalDb: Kysely<GlobalDatabase>
  let tc: Awaited<ReturnType<typeof createTestContext>>
  let app: express.Express

  beforeEach(async () => {
    tc = await createTestContext()
    groupDb = tc.groupDb
    globalDb = tc.globalDb
    app = createTestApp(tc.ctx, registerXrpcMethods)
    await seedMemberWithIndex(groupDb, globalDb, OWNER, GROUP, 'owner')
    await seedMemberWithIndex(groupDb, globalDb, ADMIN, GROUP, 'admin')
    await seedMemberWithIndex(groupDb, globalDb, MEMBER, GROUP, 'member')
  })

  afterEach(async () => {
    await groupDb.destroy()
    await globalDb.destroy()
  })

  const get = (query: Record<string, string | number>, auth?: string) => {
    const req = request(app).get(`/xrpc/${NSID}`).query(query)
    return auth ? req.set('Authorization', auth) : req
  }

  it('lists the owner and all members for an operator who is not a member', async () => {
    const res = await get({ repo: GROUP }, basic('admin', TEST_ADMIN_PASSWORD))

    expect(res.status).toBe(200)
    const byDid = Object.fromEntries(res.body.members.map((m: any) => [m.did, m]))
    expect(Object.keys(byDid).sort()).toEqual([ADMIN, MEMBER, OWNER].sort())
    expect(byDid[OWNER].role).toBe('owner')
    expect(byDid[ADMIN].role).toBe('admin')
    expect(byDid[MEMBER].role).toBe('member')
    expect(byDid[OWNER].addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(res.body.cursor).toBeUndefined()
  })

  it('paginates with limit and cursor', async () => {
    const auth = basic('admin', TEST_ADMIN_PASSWORD)
    const first = await get({ repo: GROUP, limit: 2 }, auth)
    expect(first.status).toBe(200)
    expect(first.body.members).toHaveLength(2)
    expect(first.body.cursor).toBeTypeOf('string')

    const second = await get({ repo: GROUP, limit: 2, cursor: first.body.cursor }, auth)
    expect(second.status).toBe(200)
    expect(second.body.members).toHaveLength(1)
    expect(second.body.cursor).toBeUndefined()

    const all = [...first.body.members, ...second.body.members].map((m: any) => m.did)
    expect(new Set(all).size).toBe(3)
  })

  it('rejects a malformed cursor', async () => {
    const res = await get({ repo: GROUP, cursor: 'bm9wZQ==' }, basic('admin', TEST_ADMIN_PASSWORD))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidCursor')
  })

  it('rejects an unknown group with UnknownGroup', async () => {
    const res = await get({ repo: 'did:plc:doesnotexist' }, basic('admin', TEST_ADMIN_PASSWORD))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('UnknownGroup')
  })

  it('rejects a request with no credentials', async () => {
    const res = await get({ repo: GROUP })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('AuthenticationRequired')
  })

  it('rejects a wrong admin password', async () => {
    const res = await get({ repo: GROUP }, basic('admin', 'wrong-password'))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('AuthenticationRequired')
  })

  it('is disabled when no admin password is configured', async () => {
    const real = new AuthVerifier({} as any, {} as any, globalDb, 'did:web:svc', {} as any)
    const disabledApp = createTestApp(
      {
        ...tc.ctx,
        authVerifier: { ...tc.ctx.authVerifier, xrpcAdminAuth: () => real.xrpcAdminAuth() } as any,
      },
      registerXrpcMethods,
    )
    const res = await request(disabledApp)
      .get(`/xrpc/${NSID}`)
      .query({ repo: GROUP })
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('AuthenticationRequired')
    expect(res.body.message).toMatch(/disabled/i)
  })
})
