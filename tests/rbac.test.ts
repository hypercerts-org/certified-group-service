import { describe, it, expect, beforeEach } from 'vitest'
import { canPerform, type Role, type Operation } from '../src/rbac/permissions.js'
import { RbacChecker } from '../src/rbac/check.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { seedMember, seedAuthorship } from './helpers/mock-server.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

describe('canPerform', () => {
  const memberOps: Operation[] = ['createRecord', 'uploadBlob', 'deleteOwnRecord', 'putOwnRecord', 'putAnyRecord', 'member.list']
  const adminOps: Operation[] = ['deleteAnyRecord', 'putRecord:profile', 'member.add', 'member.remove', 'audit.query']
  const ownerOps: Operation[] = ['role.set']

  it('member can perform member-level ops', () => {
    for (const op of memberOps) expect(canPerform('member', op)).toBe(true)
  })

  it('member cannot perform admin/owner ops', () => {
    for (const op of [...adminOps, ...ownerOps]) expect(canPerform('member', op)).toBe(false)
  })

  it('admin can perform member + admin ops', () => {
    for (const op of [...memberOps, ...adminOps]) expect(canPerform('admin', op)).toBe(true)
  })

  it('admin cannot perform owner ops', () => {
    for (const op of ownerOps) expect(canPerform('admin', op)).toBe(false)
  })

  it('owner can perform all ops', () => {
    for (const op of [...memberOps, ...adminOps, ...ownerOps]) expect(canPerform('owner', op)).toBe(true)
  })
})

describe('RbacChecker', () => {
  let groupDb: Kysely<GroupDatabase>
  let rbac: RbacChecker

  beforeEach(async () => {
    groupDb = await createTestGroupDb()
    rbac = new RbacChecker()
    await seedMember(groupDb, 'did:plc:member1', 'member')
  })

  it('assertCan returns role on success', async () => {
    const role = await rbac.assertCan(groupDb, 'did:plc:member1', 'createRecord')
    expect(role).toBe('member')
  })

  it('assertCan throws UnauthorizedError for non-member', async () => {
    await expect(rbac.assertCan(groupDb, 'did:plc:nobody', 'createRecord')).rejects.toThrow('Not a member')
  })

  it('assertCan throws ForbiddenError for insufficient role', async () => {
    await expect(rbac.assertCan(groupDb, 'did:plc:member1', 'member.add')).rejects.toThrow(/cannot perform/)
  })

  it('isAuthor returns true for matching author', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:g/app.bsky.feed.post/1', 'did:plc:member1', 'app.bsky.feed.post')
    expect(await rbac.isAuthor(groupDb, 'at://did:plc:g/app.bsky.feed.post/1', 'did:plc:member1')).toBe(true)
  })

  it('isAuthor returns false for non-author', async () => {
    await seedAuthorship(groupDb, 'at://did:plc:g/app.bsky.feed.post/1', 'did:plc:other', 'app.bsky.feed.post')
    expect(await rbac.isAuthor(groupDb, 'at://did:plc:g/app.bsky.feed.post/1', 'did:plc:member1')).toBe(false)
  })
})
