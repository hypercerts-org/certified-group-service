/**
 * Steps for import.feature — group.import and group.destroy as subjects under
 * test. Import is service-level (aud = service DID, importer-signed); destroy is
 * group-scoped (aud = group DID, owner-signed).
 */
import { When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc } from '../support/cgs.js'

const IMPORT_NSID = 'app.certified.group.import'
const DESTROY_NSID = 'app.certified.group.destroy'

async function doImport(world: CgsWorld): Promise<void> {
  const token = await mintServiceAuth({
    identifier: world.env.importerIdentifier,
    password: world.env.importerPassword,
    aud: world.serviceDid,
    lxm: IMPORT_NSID,
  })
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: IMPORT_NSID,
    token,
    body: {
      groupDid: world.groupDid,
      appPassword: world.env.importerAppPassword,
      ownerDid: world.ownerDid,
    },
  })
}

When('the importer imports the account as a group', async function (this: CgsWorld) {
  await doImport(this)
})

When('the importer imports the account as a group again', async function (this: CgsWorld) {
  await doImport(this)
})

When('the owner destroys the group', async function (this: CgsWorld) {
  const token = await mintServiceAuth({
    identifier: this.env.ownerIdentifier,
    password: this.env.ownerPassword,
    aud: this.groupDid!,
    lxm: DESTROY_NSID,
  })
  await callXrpc(this, { cgsUrl: this.env.cgsUrl, nsid: DESTROY_NSID, token })
})

Then('the import response returns the group handle', function (this: CgsWorld) {
  const handle = (this.lastHttpJson as { handle?: string } | undefined)?.handle
  assert.ok(handle, `expected a group handle in the import response, got ${this.lastHttpBody}`)
})

Then('the destroy response returns the group DID', function (this: CgsWorld) {
  const groupDid = (this.lastHttpJson as { groupDid?: string } | undefined)?.groupDid
  assert.equal(groupDid, this.groupDid, `expected groupDid ${this.groupDid}, got ${groupDid}`)
})
