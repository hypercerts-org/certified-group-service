import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMemberWithIndex, createTestApp, mockAuth } from './helpers/mock-server.js'
import { createTestGroupDb } from './helpers/test-db.js'
import membershipListHandler from '../src/api/membership/list.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

function buildApp(ctx: AppContext) {
  return createTestApp(ctx, (server, appCtx) => {
    membershipListHandler(server, appCtx)
  })
}

describe('groups.membership.list', () => {
  let ctx: AppContext
  let globalDb: Kysely<GlobalDatabase>
  let groupDbA: Kysely<GroupDatabase>
  let groupDbB: Kysely<GroupDatabase>
  let groupDbC: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    globalDb = test.globalDb

    // Create multiple group databases
    const testA = await createTestGroupDb()
    const testB = await createTestGroupDb()
    const testC = await createTestGroupDb()
    groupDbA = testA.db
    groupDbB = testB.db
    groupDbC = testC.db

    // Register groups in global DB
    await globalDb.insertInto('groups').values({
      did: 'did:plc:groupA',
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc_pass_a',
    }).execute()
    await globalDb.insertInto('groups').values({
      did: 'did:plc:groupB',
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc_pass_b',
    }).execute()
    await globalDb.insertInto('groups').values({
      did: 'did:plc:groupC',
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc_pass_c',
    }).execute()

    app = buildApp(ctx)
  })

  afterEach(async () => {
    await groupDbA.destroy()
    await groupDbB.destroy()
    await groupDbC.destroy()
    await globalDb.destroy()
  })

  it('returns empty list when user is not a member of any group', async () => {
    const res = await request(app).get('/xrpc/app.certified.groups.membership.list')
    expect(res.status).toBe(200)
    expect(res.body.groups).toEqual([])
  })

  it('returns groups the user belongs to', async () => {
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:testuser', 'did:plc:groupA', 'member')
    await seedMemberWithIndex(groupDbB, globalDb, 'did:plc:testuser', 'did:plc:groupB', 'admin')

    const res = await request(app).get('/xrpc/app.certified.groups.membership.list')
    expect(res.status).toBe(200)
    expect(res.body.groups).toHaveLength(2)

    const dids = res.body.groups.map((g: any) => g.groupDid)
    expect(dids).toContain('did:plc:groupA')
    expect(dids).toContain('did:plc:groupB')

    const groupA = res.body.groups.find((g: any) => g.groupDid === 'did:plc:groupA')
    expect(groupA.role).toBe('member')
    expect(groupA.joinedAt).toBeDefined()

    const groupB = res.body.groups.find((g: any) => g.groupDid === 'did:plc:groupB')
    expect(groupB.role).toBe('admin')
  })

  it('does not include groups the user is not a member of', async () => {
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:testuser', 'did:plc:groupA', 'member')
    await seedMemberWithIndex(groupDbC, globalDb, 'did:plc:otheruser', 'did:plc:groupC', 'member')

    const res = await request(app).get('/xrpc/app.certified.groups.membership.list')
    expect(res.status).toBe(200)
    expect(res.body.groups).toHaveLength(1)
    expect(res.body.groups[0].groupDid).toBe('did:plc:groupA')
  })

  it('returns owner role correctly', async () => {
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:testuser', 'did:plc:groupA', 'owner')

    const res = await request(app).get('/xrpc/app.certified.groups.membership.list')
    expect(res.status).toBe(200)
    expect(res.body.groups).toHaveLength(1)
    expect(res.body.groups[0].role).toBe('owner')
  })

  it('paginates with cursor', async () => {
    // Add user to all three groups
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:testuser', 'did:plc:groupA', 'member')
    await seedMemberWithIndex(groupDbB, globalDb, 'did:plc:testuser', 'did:plc:groupB', 'admin')
    await seedMemberWithIndex(groupDbC, globalDb, 'did:plc:testuser', 'did:plc:groupC', 'owner')

    const res1 = await request(app).get('/xrpc/app.certified.groups.membership.list?limit=2')
    expect(res1.status).toBe(200)
    expect(res1.body.groups).toHaveLength(2)
    expect(res1.body.cursor).toBeDefined()

    const res2 = await request(app).get(
      `/xrpc/app.certified.groups.membership.list?limit=2&cursor=${res1.body.cursor}`,
    )
    expect(res2.status).toBe(200)
    expect(res2.body.groups).toHaveLength(1)
    expect(res2.body.cursor).toBeUndefined()

    // Verify no duplicates across pages
    const allDids = [
      ...res1.body.groups.map((g: any) => g.groupDid),
      ...res2.body.groups.map((g: any) => g.groupDid),
    ]
    expect(new Set(allDids).size).toBe(3)
  })

  it('invalid cursor returns 400 InvalidCursor', async () => {
    const badCursor = Buffer.from('bad').toString('base64')
    const res = await request(app).get(
      `/xrpc/app.certified.groups.membership.list?cursor=${badCursor}`,
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidCursor')
  })

  it('limit=0 is rejected', async () => {
    const res = await request(app).get('/xrpc/app.certified.groups.membership.list?limit=0')
    expect(res.status).toBe(400)
  })

  it('limit exceeding maximum is rejected', async () => {
    const res = await request(app).get('/xrpc/app.certified.groups.membership.list?limit=999')
    expect(res.status).toBe(400)
  })

  it('joinedAt is a valid ISO datetime', async () => {
    await seedMemberWithIndex(groupDbA, globalDb, 'did:plc:testuser', 'did:plc:groupA', 'member')

    const res = await request(app).get('/xrpc/app.certified.groups.membership.list')
    expect(res.status).toBe(200)
    const joinedAt = res.body.groups[0].joinedAt
    expect(new Date(joinedAt).toISOString()).toBe(joinedAt)
  })

  it('paginates correctly when added_at timestamps are identical', async () => {
    const timestamp = '2025-01-01 00:00:00'
    const dids = ['did:plc:aaa', 'did:plc:bbb', 'did:plc:ccc', 'did:plc:ddd']

    // Register groups in global DB
    for (const did of dids) {
      await globalDb.insertInto('groups').values({
        did,
        pds_url: 'https://pds.example.com',
        encrypted_app_password: 'enc',
      }).execute()
    }

    // Insert directly into member_index with identical timestamps
    for (const did of dids) {
      await globalDb.insertInto('member_index').values({
        member_did: 'did:plc:testuser',
        group_did: did,
        role: 'member',
        added_by: 'did:plc:owner',
        added_at: timestamp,
      }).execute()
    }

    const res1 = await request(app).get('/xrpc/app.certified.groups.membership.list?limit=2')
    expect(res1.status).toBe(200)
    expect(res1.body.groups).toHaveLength(2)
    expect(res1.body.cursor).toBeDefined()

    const res2 = await request(app).get(
      `/xrpc/app.certified.groups.membership.list?limit=2&cursor=${res1.body.cursor}`,
    )
    expect(res2.status).toBe(200)
    expect(res2.body.groups).toHaveLength(2)
    expect(res2.body.cursor).toBeUndefined()

    // Verify all 4 DIDs returned with no duplicates
    const allDids = [
      ...res1.body.groups.map((g: any) => g.groupDid),
      ...res2.body.groups.map((g: any) => g.groupDid),
    ]
    expect(allDids).toEqual(dids) // lexicographic order
    expect(new Set(allDids).size).toBe(4)
  })

  it('multi-page pagination returns all results without duplicates', async () => {
    // Register 7 groups
    const groupDids = Array.from({ length: 7 }, (_, i) => `did:plc:page${i}`)
    for (const did of groupDids) {
      await globalDb.insertInto('groups').values({
        did,
        pds_url: 'https://pds.example.com',
        encrypted_app_password: 'enc',
      }).execute()
    }

    // Insert into member_index with ascending timestamps
    for (let i = 0; i < 7; i++) {
      await globalDb.insertInto('member_index').values({
        member_did: 'did:plc:testuser',
        group_did: groupDids[i],
        role: 'member',
        added_by: 'did:plc:owner',
        added_at: `2025-01-01 00:00:0${i + 1}`,
      }).execute()
    }

    // Page 1
    const res1 = await request(app).get('/xrpc/app.certified.groups.membership.list?limit=3')
    expect(res1.status).toBe(200)
    expect(res1.body.groups).toHaveLength(3)
    expect(res1.body.cursor).toBeDefined()

    // Page 2
    const res2 = await request(app).get(
      `/xrpc/app.certified.groups.membership.list?limit=3&cursor=${res1.body.cursor}`,
    )
    expect(res2.status).toBe(200)
    expect(res2.body.groups).toHaveLength(3)
    expect(res2.body.cursor).toBeDefined()

    // Page 3
    const res3 = await request(app).get(
      `/xrpc/app.certified.groups.membership.list?limit=3&cursor=${res2.body.cursor}`,
    )
    expect(res3.status).toBe(200)
    expect(res3.body.groups).toHaveLength(1)
    expect(res3.body.cursor).toBeUndefined()

    // Verify union of all pages
    const allDids = [
      ...res1.body.groups.map((g: any) => g.groupDid),
      ...res2.body.groups.map((g: any) => g.groupDid),
      ...res3.body.groups.map((g: any) => g.groupDid),
    ]
    expect(new Set(allDids).size).toBe(7)
    expect(new Set(allDids)).toEqual(new Set(groupDids))
  })
})
