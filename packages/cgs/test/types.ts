// Type-level tests for the built package: compiled by `pnpm test`
// (tsconfig.test.json), never run. Each @ts-expect-error must stay an error.
import { Client } from '@atproto/lex'
import { app } from '@hypercerts-org/cgs'

const cgs = new Client('https://groups.example')
const groupDid = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' as const

export type GroupMembership = app.certified.groups.membership.list.GroupMembership
export type GroupMember = app.certified.group.member.list.Member
export type AuditEntry = app.certified.group.audit.query.AuditEntry
export type GroupKey = app.certified.group.keys.list.Key

export async function memberships(): Promise<GroupMembership[]> {
  const { groups } = await cgs.call(app.certified.groups.membership.list, { limit: 100 })
  return groups
}

export async function createRecord() {
  return cgs.call(app.certified.group.repo.createRecord, {
    repo: groupDid,
    collection: 'app.certified.actor.profile',
    rkey: 'self',
    record: { $type: 'app.certified.actor.profile', displayName: 'Example' },
  })
}

export async function putRecordWithSwap() {
  return cgs.call(app.certified.group.repo.putRecord, {
    repo: groupDid,
    collection: 'app.certified.actor.profile',
    rkey: 'self',
    record: { $type: 'app.certified.actor.profile', displayName: 'Example' },
    swapRecord: null,
  })
}

export async function setRole() {
  return cgs.call(app.certified.group.role.set, {
    repo: groupDid,
    memberDid: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
    role: 'admin',
  })
}

export const queryParams: app.certified.group.audit.query.$Params = {
  repo: groupDid,
  limit: 25,
}

// @ts-expect-error unknown parameter
export const unknownParam = () => cgs.call(app.certified.groups.membership.list, { nope: 1 })

// @ts-expect-error repo, collection, rkey, and record are required
export const missingPutFields = () => cgs.call(app.certified.group.repo.putRecord, {})

export const missingSetOwnerFields = () =>
  // @ts-expect-error newOwner is required on admin.setOwner
  cgs.call(app.certified.group.admin.setOwner, { repo: groupDid })
