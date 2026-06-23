/**
 * Steps for register.feature (@manual). group.register is service-level (aud =
 * service DID), signed by the owner who will be seeded. Creates a brand-new PDS
 * account, so this feature is excluded from CI — see register.feature.
 *
 * A unique handle is generated per run (register leaks the account, so a fixed
 * handle would collide on the second run). The first registration succeeds; the
 * conflict scenario re-registers that same generated handle.
 */
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc } from '../support/cgs.js'

const REGISTER_NSID = 'app.certified.group.register'

/** A fresh handle local-part valid per the register handle charset ([a-zA-Z0-9-]). */
function uniqueHandle(): string {
  return `cgs-e2e-${Date.now()}`
}

async function register(world: CgsWorld, handle: string): Promise<void> {
  // Fail fast on a setup gap rather than sending an invalid payload and hiding
  // it behind an API error.
  assert.ok(
    world.ownerDid,
    'ownerDid must be resolved before register (run "the test accounts are resolved")',
  )
  const token = await mintServiceAuth({
    identifier: world.env.ownerIdentifier,
    password: world.env.ownerPassword,
    aud: world.serviceDid,
    lxm: REGISTER_NSID,
  })
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: REGISTER_NSID,
    token,
    body: { handle, ownerDid: world.ownerDid },
  })
}

When('the owner registers a new group with a unique handle', async function (this: CgsWorld) {
  this.registerHandle = uniqueHandle()
  await register(this, this.registerHandle)
})

Given('the owner has registered a new group with a unique handle', async function (this: CgsWorld) {
  this.registerHandle = uniqueHandle()
  await register(this, this.registerHandle)
  assert.equal(this.lastHttpStatus, 200, `setup register failed: ${this.lastHttpBody}`)
})

When('the owner registers a new group with that same handle', async function (this: CgsWorld) {
  assert.ok(this.registerHandle, 'no handle captured from the prior registration')
  await register(this, this.registerHandle)
})

Then('the register response returns the group DID and handle', function (this: CgsWorld) {
  const body = this.lastHttpJson as { groupDid?: string; handle?: string } | undefined
  assert.ok(body?.groupDid, `expected a groupDid, got ${this.lastHttpBody}`)
  assert.ok(body?.handle, `expected a handle, got ${this.lastHttpBody}`)
})

Then('the register response returns an account password', function (this: CgsWorld) {
  const accountPassword = (this.lastHttpJson as { accountPassword?: string } | undefined)
    ?.accountPassword
  assert.ok(accountPassword, `expected an accountPassword, got ${this.lastHttpBody}`)
})
