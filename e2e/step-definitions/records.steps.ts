/**
 * Steps for records.feature — the proxied repo surface (createRecord,
 * putRecord, uploadBlob, deleteRecord). Owner-signed; each mints a fresh JWT
 * for its NSID. These use the LEGACY targeting form (aud = the group DID, no
 * `repo`), so they double as backwards-compatibility coverage that the
 * deprecated path still works. The new form (aud = service DID + explicit
 * `repo`) is covered in aud-targeting.feature.
 */
import { When, Then, Given } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc, uploadBlobXrpc } from '../support/cgs.js'

const FEED_POST = 'app.bsky.feed.post'
const PROFILE = 'app.bsky.actor.profile'

/** Mint an owner-signed, group-scoped token for the given method. */
function ownerToken(world: CgsWorld, lxm: string): Promise<string> {
  return mintServiceAuth({
    identifier: world.env.ownerIdentifier,
    password: world.env.ownerPassword,
    aud: world.groupDid!,
    lxm,
  })
}

async function createFeedPost(world: CgsWorld): Promise<void> {
  const nsid = 'app.certified.group.repo.createRecord'
  const token = await ownerToken(world, nsid)
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid,
    token,
    body: {
      repo: world.groupDid,
      collection: FEED_POST,
      record: {
        $type: FEED_POST,
        text: 'CGS e2e post — created by the owner via the group service.',
        createdAt: new Date().toISOString(),
      },
    },
  })
  const uri = (world.lastHttpJson as { uri?: string } | undefined)?.uri
  if (uri) world.createdRecordUri = uri
}

When('the owner creates a feed post in the group repo', async function (this: CgsWorld) {
  await createFeedPost(this)
})

Given('the owner has created a feed post in the group repo', async function (this: CgsWorld) {
  await createFeedPost(this)
  assert.equal(this.lastHttpStatus, 200, `setup createRecord failed: ${this.lastHttpBody}`)
})

When('the owner puts a profile record in the group repo', async function (this: CgsWorld) {
  const nsid = 'app.certified.group.repo.putRecord'
  const token = await ownerToken(this, nsid)
  await callXrpc(this, {
    cgsUrl: this.env.cgsUrl,
    nsid,
    token,
    body: {
      repo: this.groupDid,
      collection: PROFILE,
      rkey: 'self',
      record: { $type: PROFILE, description: 'CGS e2e group profile.' },
    },
  })
})

When('the owner uploads a blob to the group repo', async function (this: CgsWorld) {
  const token = await ownerToken(this, 'app.certified.group.repo.uploadBlob')
  // A tiny 1x1 transparent PNG.
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const buf = Buffer.from(pngBase64, 'base64')
  // Copy into a standalone ArrayBuffer (Buffer's backing may be shared/pooled).
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  await uploadBlobXrpc(this, {
    cgsUrl: this.env.cgsUrl,
    token,
    bytes,
    contentType: 'image/png',
  })
  const blob = (this.lastHttpJson as { blob?: Record<string, unknown> } | undefined)?.blob
  if (blob) this.uploadedBlob = blob
})

When('the owner deletes that record', async function (this: CgsWorld) {
  assert.ok(this.createdRecordUri, 'no record URI captured to delete')
  // at://<did>/<collection>/<rkey>
  const rkey = this.createdRecordUri.split('/').pop()
  const nsid = 'app.certified.group.repo.deleteRecord'
  const token = await ownerToken(this, nsid)
  await callXrpc(this, {
    cgsUrl: this.env.cgsUrl,
    nsid,
    token,
    body: { repo: this.groupDid, collection: FEED_POST, rkey },
  })
})

Then('the response contains a blob reference', function (this: CgsWorld) {
  const blob = (this.lastHttpJson as { blob?: unknown } | undefined)?.blob
  assert.ok(blob, `expected a blob reference in the response, got ${this.lastHttpBody}`)
})
