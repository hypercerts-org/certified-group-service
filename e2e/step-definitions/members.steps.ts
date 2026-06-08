/**
 * Steps for membership.feature (RBAC) and reporting.feature. The group-scoped
 * methods here (member.*, role.set, audit.query, repo.createRecord) use the
 * LEGACY targeting form (aud = the group DID, no `repo`) — kept deliberately so
 * these scenarios double as backwards-compatibility coverage that the
 * deprecated path still works (#27). The new form (aud = service DID + explicit
 * `repo`) is covered in aud-targeting.feature. groups.membership.list is
 * SERVICE-level (aud = the service DID) and lists the caller's memberships
 * across groups. The caller varies by role — owner, admin, member, or outsider
 * — and each signs its own JWT, so the negative cases exercise real
 * authorization (Forbidden, 403), not a simulated denial.
 */
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc } from '../support/cgs.js'

const MEMBER_ADD = 'app.certified.group.member.add'
const MEMBER_LIST = 'app.certified.group.member.list'
const MEMBER_REMOVE = 'app.certified.group.member.remove'
const ROLE_SET = 'app.certified.group.role.set'
const AUDIT_QUERY = 'app.certified.group.audit.query'
const MEMBERSHIP_LIST = 'app.certified.groups.membership.list'
const CREATE_RECORD = 'app.certified.group.repo.createRecord'
const FEED_POST = 'app.bsky.feed.post'

type Role = 'owner' | 'admin' | 'member' | 'outsider'

/** Mint a group-scoped JWT signing as the given role's account. */
function tokenAs(world: CgsWorld, role: Role, lxm: string): Promise<string> {
  const creds: Record<Role, { identifier: string; password: string }> = {
    owner: { identifier: world.env.ownerIdentifier, password: world.env.ownerPassword },
    admin: { identifier: world.env.adminIdentifier, password: world.env.adminPassword },
    member: { identifier: world.env.memberIdentifier, password: world.env.memberPassword },
    outsider: { identifier: world.env.outsiderIdentifier, password: world.env.outsiderPassword },
  }
  return mintServiceAuth({ ...creds[role], aud: world.groupDid!, lxm })
}

async function addMember(world: CgsWorld, role: Role, memberDid: string, grantRole: string) {
  const token = await tokenAs(world, role, MEMBER_ADD)
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: MEMBER_ADD,
    token,
    body: { memberDid, role: grantRole },
  })
}

async function listMembers(world: CgsWorld, role: Role) {
  const token = await tokenAs(world, role, MEMBER_LIST)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: MEMBER_LIST, token, method: 'GET' })
}

async function queryAudit(world: CgsWorld, role: Role) {
  const token = await tokenAs(world, role, AUDIT_QUERY)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: AUDIT_QUERY, token, method: 'GET' })
}

// --- Seeding (owner adds admin + member) ---

/** Tolerate a member already existing — the group is shared across scenarios in
 *  a run, so the Background re-seeds; a 409 MemberAlreadyExists is fine. */
function seedOk(world: CgsWorld, role: string): void {
  if (world.lastHttpStatus === 200) return
  const err = (world.lastHttpJson as { error?: string } | undefined)?.error
  if (world.lastHttpStatus === 409 && err === 'MemberAlreadyExists') return
  throw new Error(`seeding ${role} failed: ${world.lastHttpStatus} ${world.lastHttpBody}`)
}

Given('the owner has seeded the admin and member accounts', async function (this: CgsWorld) {
  await addMember(this, 'owner', this.adminDid!, 'admin')
  seedOk(this, 'admin')
  await addMember(this, 'owner', this.memberDid!, 'member')
  seedOk(this, 'member')
})

// --- Owner / positive ---

When('the owner lists the group members', async function (this: CgsWorld) {
  await listMembers(this, 'owner')
})

When('the admin queries the audit log', async function (this: CgsWorld) {
  await queryAudit(this, 'admin')
})

When('the member creates a feed post in the group repo', async function (this: CgsWorld) {
  const token = await tokenAs(this, 'member', CREATE_RECORD)
  await callXrpc(this, {
    cgsUrl: this.env.cgsUrl,
    nsid: CREATE_RECORD,
    token,
    body: {
      repo: this.groupDid,
      collection: FEED_POST,
      record: {
        $type: FEED_POST,
        text: 'CGS e2e post — created by a member.',
        createdAt: new Date().toISOString(),
      },
    },
  })
})

// --- Negative (403) ---

When('the member queries the audit log', async function (this: CgsWorld) {
  await queryAudit(this, 'member')
})

When('the outsider lists the group members', async function (this: CgsWorld) {
  await listMembers(this, 'outsider')
})

When("the admin sets the member's role to admin", async function (this: CgsWorld) {
  const token = await tokenAs(this, 'admin', ROLE_SET)
  await callXrpc(this, {
    cgsUrl: this.env.cgsUrl,
    nsid: ROLE_SET,
    token,
    body: { memberDid: this.memberDid, role: 'admin' },
  })
})

When('the admin adds a member with the admin role', async function (this: CgsWorld) {
  // The admin attempts to grant a role at its own level — rejected by the
  // role-ceiling check. Uses the outsider DID as the would-be new member.
  await addMember(this, 'admin', this.outsiderDid!, 'admin')
})

// --- Cleanup ---

When('the owner removes the admin and member accounts', async function (this: CgsWorld) {
  for (const memberDid of [this.adminDid!, this.memberDid!]) {
    const token = await tokenAs(this, 'owner', MEMBER_REMOVE)
    await callXrpc(this, {
      cgsUrl: this.env.cgsUrl,
      nsid: MEMBER_REMOVE,
      token,
      body: { memberDid },
    })
    // 200 = removed; 404 MemberNotFound = already gone (tolerated so the cleanup
    // is idempotent across re-runs / ordering).
    const err = (this.lastHttpJson as { error?: string } | undefined)?.error
    const ok =
      this.lastHttpStatus === 200 || (this.lastHttpStatus === 404 && err === 'MemberNotFound')
    assert.ok(ok, `removing ${memberDid} failed: ${this.lastHttpStatus} ${this.lastHttpBody}`)
  }
})

// --- Assertions specific to membership / reporting ---

Then('the members list includes the admin and the member', function (this: CgsWorld) {
  // The member.list lexicon returns each member as { did, role, addedBy, addedAt }.
  const members = (this.lastHttpJson as { members?: Array<{ did?: string }> } | undefined)?.members
  assert.ok(Array.isArray(members), `expected a members array, got ${this.lastHttpBody}`)
  const dids = members.map((m) => m.did)
  assert.ok(dids.includes(this.adminDid), `members list missing admin ${this.adminDid}`)
  assert.ok(dids.includes(this.memberDid), `members list missing member ${this.memberDid}`)
})

Then('the response contains audit entries', function (this: CgsWorld) {
  const entries = (this.lastHttpJson as { entries?: unknown[] } | undefined)?.entries
  assert.ok(
    Array.isArray(entries) && entries.length > 0,
    `expected audit entries, got ${this.lastHttpBody}`,
  )
})

// --- reporting.feature ---

When('the owner queries the audit log', async function (this: CgsWorld) {
  await queryAudit(this, 'owner')
})

When('the owner lists their group memberships', async function (this: CgsWorld) {
  // membership.list is SERVICE-level (aud = the service DID), not group-scoped:
  // it returns the groups the caller belongs to, across all groups.
  const token = await mintServiceAuth({
    identifier: this.env.ownerIdentifier,
    password: this.env.ownerPassword,
    aud: this.serviceDid,
    lxm: MEMBERSHIP_LIST,
  })
  await callXrpc(this, { cgsUrl: this.env.cgsUrl, nsid: MEMBERSHIP_LIST, token, method: 'GET' })
})

Then('the memberships include the group', function (this: CgsWorld) {
  const groups = (
    this.lastHttpJson as { groups?: Array<{ groupDid?: string } | string> } | undefined
  )?.groups
  assert.ok(Array.isArray(groups), `expected a groups array, got ${this.lastHttpBody}`)
  const found = groups.some((g) =>
    typeof g === 'string' ? g === this.groupDid : g.groupDid === this.groupDid,
  )
  assert.ok(found, `memberships missing group ${this.groupDid}`)
})
