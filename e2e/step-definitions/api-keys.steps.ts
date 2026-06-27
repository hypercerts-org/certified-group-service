/**
 * Steps for api-keys.feature — the platform backend-sync flow (#26):
 * a member mints a scoped key (JWT-authed keys.create), a backend uses it via the
 * X-API-Key header (no JWT), and the creator or owner revokes it. Group targeting is the
 * same request-level `repo` the JWT new path uses.
 */
import { When, Then, Given } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { mintServiceAuth, callXrpc, callXrpcWithApiKey } from '../support/cgs.js'
import { scopeNeededFor } from '../../src/auth/scopes.js'

const KEYS_CREATE = 'app.certified.group.keys.create'
const KEYS_LIST = 'app.certified.group.keys.list'
const KEYS_DELETE = 'app.certified.group.keys.delete'
const MEMBER_LIST = 'app.certified.group.member.list'
const AUDIT_QUERY = 'app.certified.group.audit.query'

type KeyActor = 'owner' | 'member'

function credsFor(world: CgsWorld, actor: KeyActor) {
  if (actor === 'owner') {
    return { identifier: world.env.ownerIdentifier, password: world.env.ownerPassword }
  }
  return { identifier: world.env.memberIdentifier, password: world.env.memberPassword }
}

const FEED_POST = 'app.bsky.feed.post'
const CREATE_RECORD = 'app.certified.group.repo.createRecord'

function memberListScope(world: CgsWorld): string {
  const scope = scopeNeededFor('member.list', world.serviceDid)
  assert.ok(scope, 'member.list must be a key-accessible operation')
  return scope
}

/** Mint an API key with the given scopes (JWT-authed keys.create). */
async function createKey(
  world: CgsWorld,
  scopes: string[],
  actor: KeyActor = 'owner',
): Promise<void> {
  const token = await mintServiceAuth({
    ...credsFor(world, actor),
    aud: world.serviceDid,
    lxm: KEYS_CREATE,
  })
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: KEYS_CREATE,
    token,
    body: { repo: world.groupDid, name: `${actor} platform backend e2e key`, scopes },
  })
  if (world.lastHttpStatus === 200 && world.lastHttpJson) {
    world.apiKey = world.lastHttpJson.key as string
    world.apiKeyRef = world.lastHttpJson.keyRef as string
    if (actor === 'owner') {
      world.ownerApiKeyRef = world.apiKeyRef
    } else {
      world.memberApiKeyRef = world.apiKeyRef
    }
  }
}

When('the owner creates an API key scoped to member.list', async function (this: CgsWorld) {
  await createKey(this, [memberListScope(this)])
})

When('the member creates an API key scoped to member.list', async function (this: CgsWorld) {
  await createKey(this, [memberListScope(this)], 'member')
})

Given('the owner has created an API key scoped to member.list', async function (this: CgsWorld) {
  await createKey(this, [memberListScope(this)])
  assert.equal(this.lastHttpStatus, 200, 'key creation should succeed in setup')
  assert.ok(this.apiKey, 'an API key should have been returned')
})

Given('the member has created an API key scoped to member.list', async function (this: CgsWorld) {
  await createKey(this, [memberListScope(this)], 'member')
  assert.equal(this.lastHttpStatus, 200, 'key creation should succeed in setup')
  assert.ok(this.apiKey, 'an API key should have been returned')
})

Then('the response contains an API key and keyRef', function (this: CgsWorld) {
  assert.ok(this.apiKey, 'expected an API key in the response')
  assert.match(this.apiKey, /^cgsk_/, 'API key should have the cgsk_ prefix')
  assert.ok(this.apiKeyRef, 'expected a keyRef in the response')
})

When('a backend lists the group members using the API key', async function (this: CgsWorld) {
  assert.ok(this.apiKey, 'no API key available for the backend call')
  await callXrpcWithApiKey(this, {
    cgsUrl: this.env.cgsUrl,
    nsid: MEMBER_LIST,
    apiKey: this.apiKey,
    method: 'GET',
    repo: this.groupDid,
  })
})

When('a backend queries the audit log using the API key', async function (this: CgsWorld) {
  assert.ok(this.apiKey, 'no API key available for the backend call')
  await callXrpcWithApiKey(this, {
    cgsUrl: this.env.cgsUrl,
    nsid: AUDIT_QUERY,
    apiKey: this.apiKey,
    method: 'GET',
    repo: this.groupDid,
  })
})

async function revokeKey(world: CgsWorld, actor: KeyActor): Promise<void> {
  assert.ok(world.apiKeyRef, 'no keyRef available to revoke')
  const token = await mintServiceAuth({
    ...credsFor(world, actor),
    aud: world.serviceDid,
    lxm: KEYS_DELETE,
  })
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: KEYS_DELETE,
    token,
    body: { repo: world.groupDid, keyRef: world.apiKeyRef },
  })
}

When('the owner revokes the API key', async function (this: CgsWorld) {
  await revokeKey(this, 'owner')
})

When('the member revokes the API key', async function (this: CgsWorld) {
  await revokeKey(this, 'member')
})

async function listKeys(world: CgsWorld, actor: KeyActor): Promise<void> {
  const token = await mintServiceAuth({
    ...credsFor(world, actor),
    aud: world.serviceDid,
    lxm: KEYS_LIST,
  })
  await callXrpc(world, {
    cgsUrl: world.env.cgsUrl,
    nsid: KEYS_LIST,
    token,
    method: 'GET',
    repo: world.groupDid,
  })
}

When('the owner lists the group API keys', async function (this: CgsWorld) {
  await listKeys(this, 'owner')
})

When('the member lists the group API keys', async function (this: CgsWorld) {
  await listKeys(this, 'member')
})

function listedKeyRefs(world: CgsWorld): string[] {
  const json = world.lastHttpJson as { keys?: Array<{ keyRef?: string }> } | undefined
  assert.ok(Array.isArray(json?.keys), `expected keys array, got ${world.lastHttpBody}`)
  return json.keys.map((key) => key.keyRef).filter((keyRef): keyRef is string => Boolean(keyRef))
}

Then('the API key list does not contain any secret material', function (this: CgsWorld) {
  const body = this.lastHttpBody ?? ''
  assert.ok(!body.includes('cgsk_'), 'keys.list must not leak a plaintext key')
  const json = this.lastHttpJson as { keys?: Array<Record<string, unknown>> } | undefined
  for (const key of json?.keys ?? []) {
    assert.ok(!('key' in key), 'key entry must not include the plaintext')
    assert.ok(!('key_hash' in key) && !('keyHash' in key), 'key entry must not include the hash')
  }
})

Then('the API key list contains the member key but not the owner key', function (this: CgsWorld) {
  assert.ok(this.memberApiKeyRef, 'expected a member-created keyRef')
  assert.ok(this.ownerApiKeyRef, 'expected an owner-created keyRef')
  const refs = listedKeyRefs(this)
  assert.ok(refs.includes(this.memberApiKeyRef), `missing member key ${this.memberApiKeyRef}`)
  assert.ok(
    !refs.includes(this.ownerApiKeyRef),
    `member list leaked owner key ${this.ownerApiKeyRef}`,
  )
})

Then('the API key list contains both the member and owner keys', function (this: CgsWorld) {
  assert.ok(this.memberApiKeyRef, 'expected a member-created keyRef')
  assert.ok(this.ownerApiKeyRef, 'expected an owner-created keyRef')
  const refs = listedKeyRefs(this)
  assert.ok(refs.includes(this.memberApiKeyRef), `missing member key ${this.memberApiKeyRef}`)
  assert.ok(refs.includes(this.ownerApiKeyRef), `missing owner key ${this.ownerApiKeyRef}`)
})

Given(
  'the owner has created an API key scoped to create feed posts',
  async function (this: CgsWorld) {
    // Friendly repo: scope — the service binds it (repo: scopes carry no aud).
    await createKey(this, [`repo:${FEED_POST}?action=create`])
    assert.equal(this.lastHttpStatus, 200, 'key creation should succeed in setup')
    assert.ok(this.apiKey, 'an API key should have been returned')
  },
)

When('a backend creates a feed post using the API key', async function (this: CgsWorld) {
  assert.ok(this.apiKey, 'no API key available for the backend call')
  await callXrpcWithApiKey(this, {
    cgsUrl: this.env.cgsUrl,
    nsid: CREATE_RECORD,
    apiKey: this.apiKey,
    repo: this.groupDid, // querystring repo — API-key procedures target via the querystring
    body: {
      repo: this.groupDid,
      collection: FEED_POST,
      record: {
        $type: FEED_POST,
        text: 'CGS e2e post via API key — #26 write scope.',
        createdAt: new Date().toISOString(),
      },
    },
  })
})
