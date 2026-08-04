/**
 * Steps for ownership-transfer.feature — the member-facing
 * app.certified.group.ownershipTransfer.* handshake (propose/accept/cancel/status).
 * Every call is a real service-auth JWT signed by the acting role's account, so the
 * negative cases exercise genuine authorization (owner-only propose, recipient-only
 * accept, party-only status) and `accept` proves live DID control of the recipient.
 *
 * Like members.steps.ts these use the LEGACY targeting form (aud = the group DID,
 * no `repo`), which doubles as backwards-compatibility coverage of the deprecated
 * path (#27); the new form is covered by aud-targeting.feature.
 *
 * The one scenario that completes a transfer reverts it in-scenario. It is also
 * tagged @needs-cgs-admin so the admin.steps.ts After-hook force-reverts ownership
 * to the original owner if the scenario fails after the first transfer — the shared
 * test group must not leak an admin-owned state into later scenarios.
 */
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc } from '../support/cgs.js'

const PROPOSE = 'app.certified.group.ownershipTransfer.propose'
const ACCEPT = 'app.certified.group.ownershipTransfer.accept'
const CANCEL = 'app.certified.group.ownershipTransfer.cancel'
const STATUS = 'app.certified.group.ownershipTransfer.status'
const MEMBER_LIST = 'app.certified.group.member.list'

type Role = 'owner' | 'admin' | 'member' | 'outsider'

/** DID for a role, as resolved in the Background. */
function didFor(world: CgsWorld, role: Role): string {
  const map: Record<Role, string | undefined> = {
    owner: world.ownerDid,
    admin: world.adminDid,
    member: world.memberDid,
    outsider: world.outsiderDid,
  }
  const did = map[role]
  assert.ok(did, `${role} DID not resolved`)
  return did
}

/** Mint a group-scoped JWT (legacy aud = group DID) signing as the given role. */
function tokenAs(world: CgsWorld, role: Role, lxm: string): Promise<string> {
  const creds: Record<Role, { identifier: string; password: string }> = {
    owner: { identifier: world.env.ownerIdentifier, password: world.env.ownerPassword },
    admin: { identifier: world.env.adminIdentifier, password: world.env.adminPassword },
    member: { identifier: world.env.memberIdentifier, password: world.env.memberPassword },
    outsider: { identifier: world.env.outsiderIdentifier, password: world.env.outsiderPassword },
  }
  return mintServiceAuth({ ...creds[role], aud: world.groupDid!, lxm })
}

async function propose(world: CgsWorld, caller: Role, newOwner: Role): Promise<void> {
  const token = await tokenAs(world, caller, PROPOSE)
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: PROPOSE,
    token,
    body: { newOwner: didFor(world, newOwner) },
  })
}

async function accept(world: CgsWorld, caller: Role): Promise<void> {
  const token = await tokenAs(world, caller, ACCEPT)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: ACCEPT, token, body: {} })
}

async function cancel(world: CgsWorld, caller: Role): Promise<void> {
  const token = await tokenAs(world, caller, CANCEL)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: CANCEL, token, body: {} })
}

async function status(world: CgsWorld, caller: Role): Promise<void> {
  const token = await tokenAs(world, caller, STATUS)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: STATUS, token, method: 'GET' })
}

/** True when a role currently holds the owner role, via member.list as the owner. */
async function currentOwnerIs(world: CgsWorld, role: Role): Promise<boolean> {
  // List as whoever should be able to (the current owner is a safe caller); fall
  // back to the acting role's own token so this works right after a transfer.
  const token = await tokenAs(world, role, MEMBER_LIST)
  await callXrpc(world, { cgsUrl: world.env.cgsUrl, nsid: MEMBER_LIST, token, method: 'GET' })
  const members = (world.lastHttpJson as { members?: Array<{ did?: string; role?: string }> })
    ?.members
  assert.ok(Array.isArray(members), `expected members array, got ${world.lastHttpBody}`)
  const ownerRow = members.find((m) => m.role === 'owner')
  return ownerRow?.did === didFor(world, role)
}

// --- Background ---

Given('there is no pending ownership transfer', async function (this: CgsWorld) {
  // Best-effort: clear any leftover proposal so scenarios start clean. A cancel by
  // the owner clears it; a 404 (nothing pending) is equally fine.
  await cancel(this, 'owner')
  const ok =
    this.lastHttpStatus === 200 ||
    (this.lastHttpStatus === 404 &&
      (this.lastHttpJson as { error?: string })?.error === 'NoPendingTransfer')
  assert.ok(ok, `pre-clear failed: ${this.lastHttpStatus} ${this.lastHttpBody}`)
})

// --- propose ---

When('the owner proposes the admin as the new owner', async function (this: CgsWorld) {
  await propose(this, 'owner', 'admin')
})

When('the owner proposes the member as the new owner', async function (this: CgsWorld) {
  await propose(this, 'owner', 'member')
})

When('the owner proposes the outsider as the new owner', async function (this: CgsWorld) {
  await propose(this, 'owner', 'outsider')
})

When('the owner proposes the owner as the new owner', async function (this: CgsWorld) {
  await propose(this, 'owner', 'owner')
})

When('the admin proposes the member as the new owner', async function (this: CgsWorld) {
  await propose(this, 'admin', 'member')
})

When('the admin proposes the owner as the new owner', async function (this: CgsWorld) {
  await propose(this, 'admin', 'owner')
})

// --- accept ---

When('the admin accepts the ownership transfer', async function (this: CgsWorld) {
  await accept(this, 'admin')
})

When('the member accepts the ownership transfer', async function (this: CgsWorld) {
  await accept(this, 'member')
})

When('the owner accepts the ownership transfer', async function (this: CgsWorld) {
  await accept(this, 'owner')
})

// --- cancel ---

When('the owner cancels the ownership transfer', async function (this: CgsWorld) {
  await cancel(this, 'owner')
})

When('the admin cancels the ownership transfer', async function (this: CgsWorld) {
  await cancel(this, 'admin')
})

// --- status ---

When('the owner queries the ownership transfer status', async function (this: CgsWorld) {
  await status(this, 'owner')
})

When('the admin queries the ownership transfer status', async function (this: CgsWorld) {
  await status(this, 'admin')
})

When('the member queries the ownership transfer status', async function (this: CgsWorld) {
  await status(this, 'member')
})

// --- assertions ---

Then('the ownershipTransfer response proposedOwner is the admin', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.proposedOwner, this.adminDid)
})

Then('the ownershipTransfer response proposedBy is the owner', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.proposedBy, this.ownerDid)
})

Then('the ownershipTransfer response owner is the admin', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.owner, this.adminDid)
})

Then('the ownershipTransfer response previousOwner is the owner', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.previousOwner, this.ownerDid)
})

Then('the ownershipTransfer response cancelled is true', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.cancelled, true)
})

Then('the status response pending is true', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.pending, true)
})

Then('the status response pending is false', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.pending, false)
})

Then('the status response proposedOwner is the admin', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.proposedOwner, this.adminDid)
})

Then('the owner is still the group owner', async function (this: CgsWorld) {
  assert.ok(await currentOwnerIs(this, 'owner'), 'expected the original owner to still be owner')
})

Then('the admin is now the group owner', async function (this: CgsWorld) {
  assert.ok(await currentOwnerIs(this, 'admin'), 'expected the admin to be the new owner')
})
