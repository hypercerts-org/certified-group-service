/**
 * Steps for admin-set-owner.feature — the operator-only
 * app.certified.group.admin.setOwner endpoint. Unlike every other feature, these
 * calls authenticate with HTTP Basic auth against the service admin password
 * (CgsWorld.env.cgsAdminPassword, from CGS_ADMIN_PASSWORD), not a member's
 * service-auth JWT. The happy path reassigns ownership to the admin account and
 * reverts it, leaving the group as it started.
 */
import { When, Then, After } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { callXrpcWithBasicAuth } from '../support/cgs.js'

const ADMIN_SET_OWNER = 'app.certified.group.admin.setOwner'

/**
 * Restore the original owner after every @needs-cgs-admin scenario, even on
 * failure. The happy-path scenario reverts ownership as its last step, but if an
 * assertion or request fails after the first transfer the group would otherwise
 * be left admin-owned and cascade into later scenarios (the suite reuses one
 * shared test group). This hook is idempotent: setOwner is a no-op when the
 * owner is already correct, and it does its own fetch so it never clobbers the
 * failure hook's captured HTTP state. Best-effort — a revert failure must not
 * mask the original scenario failure.
 */
After({ tags: '@needs-cgs-admin' }, async function (this: CgsWorld) {
  if (!this.env.cgsAdminPassword || !this.groupDid || !this.ownerDid) return
  try {
    const creds = Buffer.from(`admin:${this.env.cgsAdminPassword}`).toString('base64')
    await fetch(`${this.env.cgsUrl}/xrpc/${ADMIN_SET_OWNER}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: this.groupDid, newOwner: this.ownerDid }),
    })
  } catch {
    // Best-effort cleanup; do not overwrite the scenario's own outcome.
  }
})

function setOwner(
  world: CgsWorld,
  opts: { newOwner: string; repo?: string; password?: string; noAuth?: boolean },
): Promise<void> {
  return callXrpcWithBasicAuth(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: ADMIN_SET_OWNER,
    password: opts.password ?? world.env.cgsAdminPassword,
    noAuth: opts.noAuth,
    body: { repo: opts.repo ?? world.groupDid!, newOwner: opts.newOwner },
  })
}

When('the admin setOwner endpoint is called with no credentials', async function (this: CgsWorld) {
  await setOwner(this, { newOwner: this.adminDid!, noAuth: true })
})

When(
  'the admin setOwner endpoint is called with the wrong admin password',
  async function (this: CgsWorld) {
    await setOwner(this, { newOwner: this.adminDid!, password: 'definitely-the-wrong-password' })
  },
)

When('the operator sets the owner to the admin account', async function (this: CgsWorld) {
  await setOwner(this, { newOwner: this.adminDid! })
})

When('the operator sets the owner to the original owner account', async function (this: CgsWorld) {
  await setOwner(this, { newOwner: this.ownerDid! })
})

When('the operator sets the owner of an unknown group', async function (this: CgsWorld) {
  // A syntactically valid DID that is not a managed group.
  await setOwner(this, { repo: 'did:plc:unknowngroupxxxxxxxxxxxx', newOwner: this.adminDid! })
})

Then('the setOwner response owner is the admin', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.owner, this.adminDid)
})

Then('the setOwner response owner is the original owner', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.owner, this.ownerDid)
})

Then('the setOwner response previousOwner is the original owner', function (this: CgsWorld) {
  assert.equal(this.lastHttpJson?.previousOwner, this.ownerDid)
})
