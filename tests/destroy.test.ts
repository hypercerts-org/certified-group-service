import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AuthRequiredError } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import { createTestContext, createTestApp, mockAuth, seedMember } from './helpers/mock-server.js'
import groupDestroyHandler from '../src/api/group/destroy.js'
import type { AppContext } from '../src/context.js'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

const ENDPOINT = '/xrpc/app.certified.group.destroy'

// The shared mock auth resolves callerDid = did:plc:testuser, groupDid (aud) =
// did:plc:testgroup. Destroy reads the groups row by groupDid, so we seed it.
const GROUP_DID = 'did:plc:testgroup'
const OWNER_DID = 'did:plc:testuser'

async function seedGroupRow(globalDb: Kysely<GlobalDatabase>, did = GROUP_DID) {
  await globalDb
    .insertInto('groups')
    .values({
      did,
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'enc',
      encrypted_recovery_key: null,
    })
    .execute()
}

async function seedIndex(globalDb: Kysely<GlobalDatabase>, memberDid: string, role: string) {
  await globalDb
    .insertInto('member_index')
    .values({
      member_did: memberDid,
      group_did: GROUP_DID,
      role,
      added_by: OWNER_DID,
      added_at: '2026-01-01 00:00:00',
    })
    .execute()
}

describe('group.destroy', () => {
  let ctx: AppContext
  let globalDb: Kysely<GlobalDatabase>
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express
  let destroyGroup: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    destroyGroup = vi.fn(async () => {})
    const test = await createTestContext({
      groupDbs: {
        get: () => groupDb,
        getRaw: () => undefined,
        migrateGroup: async () => {},
        destroyGroup,
        destroyAll: async () => {},
      } as any,
    })
    ctx = test.ctx
    globalDb = test.globalDb
    groupDb = test.groupDb
    app = createTestApp(ctx, groupDestroyHandler)
  })

  afterEach(async () => {
    await globalDb.destroy()
    await groupDb.destroy()
  })

  it('owner destroys the group: drops the groups row, member index, and per-group DB', async () => {
    await seedGroupRow(globalDb)
    await seedMember(groupDb, OWNER_DID, 'owner')
    await seedIndex(globalDb, OWNER_DID, 'owner')
    await seedIndex(globalDb, 'did:plc:member1', 'member')

    const res = await request(app).post(ENDPOINT)
    expect(res.status).toBe(200)
    expect(res.body.groupDid).toBe(GROUP_DID)

    // groups row gone
    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', GROUP_DID)
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()

    // member_index rows for this group gone
    const idx = await globalDb
      .selectFrom('member_index')
      .where('group_did', '=', GROUP_DID)
      .selectAll()
      .execute()
    expect(idx).toHaveLength(0)

    // per-group DB destroyed
    expect(destroyGroup).toHaveBeenCalledWith(GROUP_DID)
  })

  it('rejects a non-owner (admin) and tears nothing down', async () => {
    await seedGroupRow(globalDb)
    await seedMember(groupDb, OWNER_DID, 'admin')

    const res = await request(app).post(ENDPOINT)
    expect(res.status).toBe(403)

    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', GROUP_DID)
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeDefined()
    expect(destroyGroup).not.toHaveBeenCalled()
  })

  it('rejects a regular member', async () => {
    await seedGroupRow(globalDb)
    await seedMember(groupDb, OWNER_DID, 'member')

    const res = await request(app).post(ENDPOINT)
    expect(res.status).toBe(403)
    expect(destroyGroup).not.toHaveBeenCalled()
  })

  it('returns 404 GroupNotFound when the group is not registered', async () => {
    // No groups row seeded.
    await seedMember(groupDb, OWNER_DID, 'owner')

    const res = await request(app).post(ENDPOINT)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('GroupNotFound')
    expect(destroyGroup).not.toHaveBeenCalled()
  })

  it('only removes the targeted group from member_index, leaving other groups', async () => {
    await seedGroupRow(globalDb)
    await seedMember(groupDb, OWNER_DID, 'owner')
    await seedIndex(globalDb, OWNER_DID, 'owner')
    // Another group's index entry must survive.
    await globalDb
      .insertInto('member_index')
      .values({
        member_did: 'did:plc:other',
        group_did: 'did:plc:othergroup',
        role: 'owner',
        added_by: 'did:plc:other',
        added_at: '2026-01-01 00:00:00',
      })
      .execute()

    const res = await request(app).post(ENDPOINT)
    expect(res.status).toBe(200)

    const survivors = await globalDb.selectFrom('member_index').selectAll().execute()
    expect(survivors).toHaveLength(1)
    expect(survivors[0].group_did).toBe('did:plc:othergroup')
  })

  it('rejects unauthenticated requests and tears nothing down', async () => {
    const test = await createTestContext({
      authVerifier: {
        ...mockAuth(OWNER_DID),
        verify: async () => {
          throw new AuthRequiredError('Missing auth token')
        },
      },
      groupDbs: {
        get: () => groupDb,
        getRaw: () => undefined,
        migrateGroup: async () => {},
        destroyGroup,
        destroyAll: async () => {},
      } as any,
    })
    await seedGroupRow(test.globalDb)
    const otherApp = createTestApp(test.ctx, groupDestroyHandler)

    const res = await request(otherApp).post(ENDPOINT)
    expect(res.status).toBe(401)
    expect(destroyGroup).not.toHaveBeenCalled()

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })
})
