import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'
import {
  createTestContext,
  createTestApp,
  seedMemberWithIndex,
  TEST_ADMIN_PASSWORD,
} from './helpers/mock-server.js'
import adminSetOwnerHandler from '../src/api/admin/setOwner.js'

const NSID = 'app.certified.group.admin.setOwner'
const GROUP = 'did:plc:testgroup'
const OWNER = 'did:plc:owner1'
const ADMIN = 'did:plc:admin1'
const MEMBER = 'did:plc:member1'

const basic = (user: string, pass: string): string =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

describe('admin.setOwner', () => {
  let groupDb: Kysely<GroupDatabase>
  let globalDb: Kysely<GlobalDatabase>
  let app: express.Express

  beforeEach(async () => {
    const tc = await createTestContext()
    groupDb = tc.groupDb
    globalDb = tc.globalDb
    // idResolver: resolve any handle to a DID by stripping a ".handle" suffix is
    // overkill; tests pass DIDs directly. Keep default resolver.
    app = createTestApp(tc.ctx, (server, appCtx) => {
      adminSetOwnerHandler(server, appCtx)
    })
    // Seed an owner + an admin + a plain member, in BOTH the group DB and the
    // member_index, so transferOwner's cross-DB writes are observable.
    await seedMemberWithIndex(groupDb, globalDb, OWNER, GROUP, 'owner')
    await seedMemberWithIndex(groupDb, globalDb, ADMIN, GROUP, 'admin')
    await seedMemberWithIndex(groupDb, globalDb, MEMBER, GROUP, 'member')
  })

  afterEach(async () => {
    await groupDb.destroy()
    await globalDb.destroy()
  })

  const roleOf = async (db: Kysely<GroupDatabase>, did: string) =>
    (
      await db
        .selectFrom('group_members')
        .select('role')
        .where('member_did', '=', did)
        .executeTakeFirst()
    )?.role

  const indexRoleOf = async (did: string) =>
    (
      await globalDb
        .selectFrom('member_index')
        .select('role')
        .where('member_did', '=', did)
        .where('group_did', '=', GROUP)
        .executeTakeFirst()
    )?.role

  it('promotes an existing admin to owner and demotes the old owner', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: ADMIN })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      groupDid: GROUP,
      owner: ADMIN,
      previousOwner: OWNER,
      noop: false,
    })
    // Both DBs reflect the swap.
    expect(await roleOf(groupDb, ADMIN)).toBe('owner')
    expect(await roleOf(groupDb, OWNER)).toBe('admin')
    expect(await indexRoleOf(ADMIN)).toBe('owner')
    expect(await indexRoleOf(OWNER)).toBe('admin')
  })

  it('promotes a plain member to owner', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: MEMBER })

    expect(res.status).toBe(200)
    expect(res.body.owner).toBe(MEMBER)
    expect(await roleOf(groupDb, MEMBER)).toBe('owner')
    expect(await roleOf(groupDb, OWNER)).toBe('admin')
  })

  it('is a no-op when newOwner is already the owner', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: OWNER })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ owner: OWNER, noop: true })
    expect(await roleOf(groupDb, OWNER)).toBe('owner')
  })

  it('adds a non-member newOwner as owner (operator break-glass) and demotes the old owner', async () => {
    const STRANGER = 'did:plc:strangerxxxxxxxxxxxxxx'
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: STRANGER })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      owner: STRANGER,
      previousOwner: OWNER,
      addedAsMember: true,
      noop: false,
    })
    // The stranger is now an owner member in both DBs; old owner demoted.
    expect(await roleOf(groupDb, STRANGER)).toBe('owner')
    expect(await indexRoleOf(STRANGER)).toBe('owner')
    expect(await roleOf(groupDb, OWNER)).toBe('admin')
    expect(await indexRoleOf(OWNER)).toBe('admin')
  })

  it('reports addedAsMember=false when promoting an existing member', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: ADMIN })

    expect(res.status).toBe(200)
    expect(res.body.addedAsMember).toBe(false)
  })

  it('rejects an unknown group with UnknownGroup', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: 'did:plc:notagroupxxxxxxxxxxxxx', newOwner: ADMIN })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('UnknownGroup')
  })

  it('rejects a request with no credentials', async () => {
    const res = await request(app).post(`/xrpc/${NSID}`).send({ repo: GROUP, newOwner: ADMIN })

    expect(res.status).toBe(401)
    expect(await roleOf(groupDb, OWNER)).toBe('owner')
  })

  it('rejects a wrong admin password', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', 'wrong-password'))
      .send({ repo: GROUP, newOwner: ADMIN })

    expect(res.status).toBe(401)
    expect(await roleOf(groupDb, OWNER)).toBe('owner')
  })

  it('rejects a wrong admin username', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('root', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: ADMIN })

    expect(res.status).toBe(401)
  })

  it('resolves a handle newOwner to a DID', async () => {
    // Build a context whose idResolver maps the handle to ADMIN's DID.
    const tc = await createTestContext({
      idResolver: { handle: { resolve: async () => ADMIN } } as any,
    })
    try {
      await seedMemberWithIndex(tc.groupDb, tc.globalDb, OWNER, GROUP, 'owner')
      await seedMemberWithIndex(tc.groupDb, tc.globalDb, ADMIN, GROUP, 'admin')
      const handleApp = createTestApp(tc.ctx, (server, appCtx) =>
        adminSetOwnerHandler(server, appCtx),
      )

      const res = await request(handleApp)
        .post(`/xrpc/${NSID}`)
        .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
        .send({ repo: GROUP, newOwner: 'alice.example.com' })

      expect(res.status).toBe(200)
      expect(res.body.owner).toBe(ADMIN)
    } finally {
      await tc.groupDb.destroy()
      await tc.globalDb.destroy()
    }
  })

  it('rejects an unresolvable handle newOwner', async () => {
    const tc = await createTestContext({
      idResolver: { handle: { resolve: async () => undefined } } as any,
    })
    try {
      await seedMemberWithIndex(tc.groupDb, tc.globalDb, OWNER, GROUP, 'owner')
      const handleApp = createTestApp(tc.ctx, (server, appCtx) =>
        adminSetOwnerHandler(server, appCtx),
      )

      const res = await request(handleApp)
        .post(`/xrpc/${NSID}`)
        .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
        .send({ repo: GROUP, newOwner: 'ghost.example.com' })

      expect(res.status).toBe(400)
    } finally {
      await tc.groupDb.destroy()
      await tc.globalDb.destroy()
    }
  })

  it('rejects an invalid newOwner DID', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: 'did:invalid' })

    expect(res.status).toBe(400)
  })

  it('does not mask an unexpected repo-resolution failure as UnknownGroup', async () => {
    // A non-AuthRequiredError from resolveRepoToGroup (e.g. a transient resolver
    // failure) must surface as a 5xx, not be misreported as a 404 UnknownGroup.
    const tc = await createTestContext()
    tc.ctx.authVerifier.resolveRepoToGroup = async () => {
      throw new Error('resolver exploded')
    }
    try {
      const failApp = createTestApp(tc.ctx, (server, appCtx) =>
        adminSetOwnerHandler(server, appCtx),
      )
      const res = await request(failApp)
        .post(`/xrpc/${NSID}`)
        .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
        .send({ repo: GROUP, newOwner: ADMIN })

      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(res.body.error).not.toBe('UnknownGroup')
    } finally {
      await tc.groupDb.destroy()
      await tc.globalDb.destroy()
    }
  })
})
