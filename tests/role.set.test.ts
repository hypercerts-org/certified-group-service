import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { XRPCError } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { buildTestServer, seedMember } from './helpers/mock-server.js'
import roleSetHandler from '../src/api/role/set.js'

async function roleSet(url: string, memberDid: string, role: string) {
  const res = await fetch(`${url}/xrpc/org.groupds.role.set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({ memberDid, role }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('role.set — last-owner protection', () => {
  let groupDb: Kysely<GroupDatabase>
  let url: string
  let close: () => Promise<void>

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    // createTestContext mock auth always returns callerDid = 'did:plc:testuser'
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    ;({ url, close } = await buildTestServer(groupDb, roleSetHandler))
  })

  afterEach(async () => {
    await close()
    await groupDb.destroy()
  })

  it('successfully demotes an owner when another owner remains', async () => {
    await seedMember(groupDb, 'did:plc:victim', 'owner')

    const { status, body } = await roleSet(url, 'did:plc:victim', 'member')

    expect(status).toBe(200)
    expect(body).toMatchObject({ memberDid: 'did:plc:victim', role: 'member' })
  })

  it('rejects demotion of the sole owner with LastOwnerDemotion', async () => {
    // testuser is the only owner
    const { status, body } = await roleSet(url, 'did:plc:testuser', 'member')

    expect(status).toBe(400)
    // XRPCError payload: { error: <third arg>, message: <second arg (error code)> }
    expect(body.message).toBe('LastOwnerDemotion')
  })

  it('promotes a non-owner member without the last-owner check', async () => {
    await seedMember(groupDb, 'did:plc:member1', 'member')

    const { status, body } = await roleSet(url, 'did:plc:member1', 'admin')

    expect(status).toBe(200)
    expect(body).toMatchObject({ memberDid: 'did:plc:member1', role: 'admin' })
  })

  it('rejects role change for unknown member with MemberNotFound', async () => {
    const { status, body } = await roleSet(url, 'did:plc:nobody', 'member')

    expect(status).toBe(404)
    expect(body.message).toBe('MemberNotFound')
  })

  it('rejects invalid role with InvalidRole', async () => {
    const { status, body } = await roleSet(url, 'did:plc:testuser', 'superadmin')

    expect(status).toBe(400)
    expect(body.message).toBe('InvalidRole')
  })

  // ---------------------------------------------------------------------------
  // Happy-path concurrency: with 3 owners, both concurrent demotions are valid
  // and should both succeed, leaving exactly 1 owner.
  // ---------------------------------------------------------------------------
  it('concurrent demotions of two owners both succeed when a third owner remains', async () => {
    await seedMember(groupDb, 'did:plc:victim1', 'owner')
    await seedMember(groupDb, 'did:plc:victim2', 'owner')
    // Now there are 3 owners: testuser, victim1, victim2.
    // Demoting victim1 and victim2 concurrently would leave testuser as sole owner.
    // Because there are 3 owners, both demotions are individually valid, so both
    // should succeed — verifying the happy path is not broken.
    const [r1, r2] = await Promise.all([
      roleSet(url, 'did:plc:victim1', 'member'),
      roleSet(url, 'did:plc:victim2', 'member'),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    const owners = await groupDb
      .selectFrom('group_members')
      .where('role', '=', 'owner')
      .selectAll()
      .execute()
    expect(owners).toHaveLength(1)
    expect(owners[0].member_did).toBe('did:plc:testuser')
  })

  it('sequential demotions: demoting the last remaining owner is rejected', async () => {
    await seedMember(groupDb, 'did:plc:victim', 'owner')
    // testuser + victim = 2 owners. Demote victim, then try to demote testuser.
    const r1 = await roleSet(url, 'did:plc:victim', 'member')
    expect(r1.status).toBe(200)

    // Only testuser remains as owner — demoting them must fail
    const r2 = await roleSet(url, 'did:plc:testuser', 'member')
    expect(r2.status).toBe(400)
    expect(r2.body.message).toBe('LastOwnerDemotion')

    const owners = await groupDb
      .selectFrom('group_members')
      .where('role', '=', 'owner')
      .selectAll()
      .execute()
    expect(owners).toHaveLength(1)
    expect(owners[0].member_did).toBe('did:plc:testuser')
  })
})

// ---------------------------------------------------------------------------
// Unit-level atomicity test: directly exercises the transaction logic,
// confirming two concurrent demotions of two SEPARATE owners (2-owner DB)
// result in exactly 1 success and 1 LastOwnerDemotion failure.
// ---------------------------------------------------------------------------
describe('role.set — transaction atomicity (direct DB)', () => {
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    await seedMember(groupDb, 'did:plc:owner1', 'owner')
    await seedMember(groupDb, 'did:plc:owner2', 'owner')
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  /** Replicates the atomic demotion logic from the fixed set.ts handler. */
  function atomicDemote(memberDid: string, newRole: string): Promise<void> {
    return groupDb.transaction().execute(async (trx) => {
      const ownerCount = await trx
        .selectFrom('group_members')
        .where('role', '=', 'owner')
        .select(trx.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()
      if (Number(ownerCount.count) <= 1) {
        throw new XRPCError(400, 'LastOwnerDemotion',
          'Cannot demote the last owner — promote a replacement first')
      }
      await trx
        .updateTable('group_members')
        .set({ role: newRole })
        .where('member_did', '=', memberDid)
        .execute()
    })
  }

  it('two concurrent owner demotions (2 owners total): exactly one succeeds', async () => {
    const results = await Promise.allSettled([
      atomicDemote('did:plc:owner1', 'member'),
      atomicDemote('did:plc:owner2', 'member'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.errorMessage).toBe('LastOwnerDemotion')

    const owners = await groupDb
      .selectFrom('group_members')
      .where('role', '=', 'owner')
      .selectAll()
      .execute()
    expect(owners).toHaveLength(1)
  })

  it('single owner cannot be demoted', async () => {
    // Remove owner2 first so only owner1 remains
    await groupDb
      .updateTable('group_members')
      .set({ role: 'member' })
      .where('member_did', '=', 'did:plc:owner2')
      .execute()

    await expect(atomicDemote('did:plc:owner1', 'member')).rejects.toMatchObject({
      errorMessage: 'LastOwnerDemotion',
    })
  })
})
