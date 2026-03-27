import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import type express from 'express'
import type { Kysely } from 'kysely'
import type { AppContext } from '../src/context.js'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'
import { createTestContext, seedMember, seedMemberWithIndex, createTestApp, mockAuth } from './helpers/mock-server.js'
import { createTestGroupDb } from './helpers/test-db.js'
import memberAddHandler from '../src/api/member/add.js'
import memberRemoveHandler from '../src/api/member/remove.js'
import roleSetHandler from '../src/api/role/set.js'
import membershipListHandler from '../src/api/membership/list.js'
import { backfillMemberIndex } from '../src/db/member-index.js'

function buildApp(ctx: AppContext) {
  return createTestApp(ctx, (server, appCtx) => {
    memberAddHandler(server, appCtx)
    memberRemoveHandler(server, appCtx)
    roleSetHandler(server, appCtx)
    membershipListHandler(server, appCtx)
  })
}

describe('member_index round-trip', () => {
  let ctx: AppContext
  let globalDb: Kysely<GlobalDatabase>
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  const ownerDid = 'did:plc:testuser'
  const groupDid = 'did:plc:testgroup'
  const memberDid = 'did:plc:newmember'

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    globalDb = test.globalDb
    groupDb = test.groupDb

    // Seed the caller as owner so they can perform all mutations
    await seedMemberWithIndex(groupDb, globalDb, ownerDid, groupDid, 'owner')

    app = buildApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
    await globalDb.destroy()
  })

  it('member.add appears in membership.list', async () => {
    // Add a member via handler
    const addRes = await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid, role: 'member' })
    expect(addRes.status).toBe(200)

    // Query membership.list as that member
    const memberApp = buildApp({ ...ctx, authVerifier: mockAuth(memberDid) })
    const listRes = await request(memberApp)
      .get('/xrpc/app.certified.groups.membership.list')
    expect(listRes.status).toBe(200)
    expect(listRes.body.groups).toHaveLength(1)
    expect(listRes.body.groups[0].groupDid).toBe(groupDid)
    expect(listRes.body.groups[0].role).toBe('member')
  })

  it('member.remove disappears from membership.list', async () => {
    // Add then remove
    await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid, role: 'member' })

    const removeRes = await request(app)
      .post('/xrpc/app.certified.group.member.remove')
      .send({ memberDid })
    expect(removeRes.status).toBe(200)

    // membership.list should be empty for that member
    const memberApp = buildApp({ ...ctx, authVerifier: mockAuth(memberDid) })
    const listRes = await request(memberApp)
      .get('/xrpc/app.certified.groups.membership.list')
    expect(listRes.status).toBe(200)
    expect(listRes.body.groups).toEqual([])
  })

  it('role.set updates membership.list', async () => {
    // Add as member
    await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid, role: 'member' })

    // Promote to admin
    const setRes = await request(app)
      .post('/xrpc/app.certified.group.role.set')
      .send({ memberDid, role: 'admin' })
    expect(setRes.status).toBe(200)

    // membership.list should reflect admin
    const memberApp = buildApp({ ...ctx, authVerifier: mockAuth(memberDid) })
    const listRes = await request(memberApp)
      .get('/xrpc/app.certified.groups.membership.list')
    expect(listRes.status).toBe(200)
    expect(listRes.body.groups).toHaveLength(1)
    expect(listRes.body.groups[0].role).toBe('admin')
  })

  it('group_members and member_index stay in sync', async () => {
    await request(app)
      .post('/xrpc/app.certified.group.member.add')
      .send({ memberDid, role: 'member' })

    const groupRow = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .where('member_did', '=', memberDid)
      .executeTakeFirst()

    const indexRow = await globalDb
      .selectFrom('member_index')
      .selectAll()
      .where('member_did', '=', memberDid)
      .where('group_did', '=', groupDid)
      .executeTakeFirst()

    expect(groupRow).toBeDefined()
    expect(indexRow).toBeDefined()
    expect(groupRow!.role).toBe(indexRow!.role)
    expect(groupRow!.added_by).toBe(indexRow!.added_by)
    expect(groupRow!.added_at).toBe(indexRow!.added_at)
  })
})

describe('backfillMemberIndex', () => {
  let globalDb: Kysely<GlobalDatabase>
  let groupDbA: Kysely<GroupDatabase>
  let groupDbB: Kysely<GroupDatabase>

  const groupADid = 'did:plc:groupA'
  const groupBDid = 'did:plc:groupB'

  beforeEach(async () => {
    const test = await createTestContext()
    globalDb = test.globalDb

    const testA = await createTestGroupDb()
    const testB = await createTestGroupDb()
    groupDbA = testA.db
    groupDbB = testB.db

    // Register groups in global DB
    await globalDb.insertInto('groups').values({
      did: groupADid,
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc_a',
    }).execute()
    await globalDb.insertInto('groups').values({
      did: groupBDid,
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc_b',
    }).execute()

    // Seed members in group DBs only (no index)
    await seedMember(groupDbA, 'did:plc:alice', 'owner')
    await seedMember(groupDbA, 'did:plc:bob', 'admin')
    await seedMember(groupDbB, 'did:plc:alice', 'member')
    await seedMember(groupDbB, 'did:plc:carol', 'member')
  })

  afterEach(async () => {
    await groupDbA.destroy()
    await groupDbB.destroy()
    await globalDb.destroy()
  })

  function makeMockGroupDbs() {
    const map: Record<string, Kysely<GroupDatabase>> = {
      [groupADid]: groupDbA,
      [groupBDid]: groupDbB,
    }
    return { get: (did: string) => map[did] } as any
  }

  it('backfills all members from all groups', async () => {
    const count = await backfillMemberIndex(globalDb, makeMockGroupDbs())
    expect(count).toBe(4)

    const rows = await globalDb.selectFrom('member_index').selectAll().execute()
    expect(rows).toHaveLength(4)

    // Verify alice appears in both groups
    const aliceRows = rows.filter((r) => r.member_did === 'did:plc:alice')
    expect(aliceRows).toHaveLength(2)
    const aliceGroups = aliceRows.map((r) => r.group_did).sort()
    expect(aliceGroups).toEqual([groupADid, groupBDid])

    // Verify roles are correct
    const aliceA = aliceRows.find((r) => r.group_did === groupADid)
    expect(aliceA!.role).toBe('owner')
    const aliceB = aliceRows.find((r) => r.group_did === groupBDid)
    expect(aliceB!.role).toBe('member')

    // Verify added_at is populated
    for (const row of rows) {
      expect(row.added_at).toBeDefined()
    }
  })

  it('idempotent — running twice does not duplicate', async () => {
    await backfillMemberIndex(globalDb, makeMockGroupDbs())
    await backfillMemberIndex(globalDb, makeMockGroupDbs())

    const rows = await globalDb.selectFrom('member_index').selectAll().execute()
    expect(rows).toHaveLength(4)
  })

  it('skips already-indexed members', async () => {
    // Pre-index alice in groupA
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:preindexed', groupADid, 'member')

    // Remove from group_members to avoid double-insert during backfill
    // (seedMemberWithIndex already inserted into group_members)
    // Actually, backfill reads group_members and inserts with onConflict doNothing,
    // so pre-indexed alice via seedMemberWithIndex should not cause duplicates.

    // Backfill should not duplicate the pre-indexed row
    await backfillMemberIndex(globalDb, makeMockGroupDbs())

    const rows = await globalDb.selectFrom('member_index').selectAll().execute()
    // 4 from backfill + 1 pre-indexed = 5 unique rows
    expect(rows).toHaveLength(5)

    // Verify no duplicates per (member_did, group_did)
    const keys = rows.map((r) => `${r.member_did}::${r.group_did}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
