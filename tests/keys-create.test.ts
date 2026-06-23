import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, createTestApp, mockAuth } from './helpers/mock-server.js'
import keysCreateHandler from '../src/api/keys/create.js'
import { parseApiKey, hashSecret } from '../src/auth/api-key.js'
import { scopeNeededFor } from '../src/auth/scopes.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const SERVICE_DID = 'did:web:test.example.com'
const MEMBER_LIST_SCOPE = scopeNeededFor('member.list', SERVICE_DID)!

function buildApp(ctx: AppContext) {
  return createTestApp(ctx, (server, appCtx) => keysCreateHandler(server, appCtx))
}

describe('keys.create', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    app = buildApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('owner mints a key; returns plaintext once and stores only the hash', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'platform backend', scopes: [MEMBER_LIST_SCOPE] })

    expect(res.status).toBe(200)
    expect(res.body.keyRef).toBeTruthy()
    expect(res.body.key).toMatch(/^cgsk_/)
    expect(res.body.scopes).toEqual([MEMBER_LIST_SCOPE])
    expect(res.body.createdAt).toBeTruthy()

    // The returned plaintext parses and its secret hashes to the stored hash.
    const parsed = parseApiKey(res.body.key)!
    expect(parsed.keyRef).toBe(res.body.keyRef)

    const row = await groupDb
      .selectFrom('group_api_keys')
      .selectAll()
      .where('key_ref', '=', res.body.keyRef)
      .executeTakeFirst()
    expect(row?.key_hash).toBe(hashSecret(parsed.secret))
    expect(row?.created_by).toBe('did:plc:testuser')
    // The plaintext secret is never stored.
    expect(JSON.stringify(row)).not.toContain(parsed.secret)
  })

  it('accepts the friendly rpc:<lxm> scope and stores the canonical aud-bound form', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'platform backend', scopes: ['rpc:app.certified.group.member.list'] })

    expect(res.status).toBe(200)
    // The client sent the short form; the server canonicalized to the aud-bound
    // scope the gate checks against.
    expect(res.body.scopes).toEqual([MEMBER_LIST_SCOPE])
    const row = await groupDb
      .selectFrom('group_api_keys')
      .select('scopes')
      .where('key_ref', '=', res.body.keyRef)
      .executeTakeFirst()
    expect(JSON.parse(row!.scopes)).toEqual([MEMBER_LIST_SCOPE])
  })

  it('rejects a scope whose aud names a different service with InvalidScope', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const foreign = `rpc:app.certified.group.member.list?aud=did:web:other.example.com%23certified_group_service`
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'foreign', scopes: [foreign] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidScope')
  })

  it('rejects a non-owner (admin) with Forbidden', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'admin')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'nope', scopes: [MEMBER_LIST_SCOPE] })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid scope string with InvalidScope', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'bad', scopes: ['not-a-scope'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidScope')
  })

  it('rejects an empty scopes array', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'empty', scopes: [] })
    expect(res.status).toBe(400)
  })

  it('an API-key caller cannot mint keys (keys.create is not key-accessible)', async () => {
    await seedMember(groupDb, 'did:plc:owner', 'owner')
    // Simulate an apiKey principal carrying a broad scope; keys.create still
    // denies because it has no scope→lxm mapping.
    ctx.authVerifier = {
      ...mockAuth('did:plc:owner'),
      xrpcAuth() {
        return async () => ({
          credentials: {
            callerDid: 'did:plc:owner',
            groupDid: 'did:plc:testgroup',
            legacyAud: false,
            authKind: 'apiKey',
            scopes: [`rpc:*?aud=${SERVICE_DID}%23certified_group_service`],
            apiKeyRef: 'ref1',
          },
        })
      },
    }
    const apiApp = buildApp(ctx)
    const res = await request(apiApp)
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'self-mint', scopes: [MEMBER_LIST_SCOPE] })
    expect(res.status).toBe(403)
  })

  it('expands an include:<nsid> permission set into the concrete stored scopes', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    // Override the resolver to return a known permission set for the include:.
    ctx.permissionSets = {
      resolve: async (nsid: string) => {
        if (nsid !== 'org.hypercerts.authWrite') throw new Error(`unknown set ${nsid}`)
        return {
          type: 'permission-set',
          permissions: [
            {
              type: 'permission',
              resource: 'repo',
              collection: ['org.hypercerts.claim.activity', 'org.hypercerts.collection'],
              action: ['create', 'update', 'delete'],
            },
          ],
        }
      },
    } as unknown as AppContext['permissionSets']

    const res = await request(buildApp(ctx))
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'hypercerts-backend', scopes: ['include:org.hypercerts.authWrite'] })

    expect(res.status).toBe(200)
    // The key stores the EXPANDED concrete repo: scope (one combined scope
    // covering all the set's collections), never the include: itself.
    expect(res.body.scopes).toHaveLength(1)
    expect(res.body.scopes[0]).toContain('collection=org.hypercerts.claim.activity')
    expect(res.body.scopes[0]).toContain('collection=org.hypercerts.collection')
    const row = await groupDb
      .selectFrom('group_api_keys')
      .select('scopes')
      .where('key_ref', '=', res.body.keyRef)
      .executeTakeFirst()
    expect(row!.scopes).not.toContain('include:')
  })

  it('returns 400 InvalidScope when an include: set cannot be resolved', async () => {
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    ctx.permissionSets = {
      resolve: async (nsid: string) => {
        throw new Error(`no _lexicon TXT for ${nsid}`)
      },
    } as unknown as AppContext['permissionSets']

    const res = await request(buildApp(ctx))
      .post('/xrpc/app.certified.group.keys.create')
      .send({ name: 'bad', scopes: ['include:org.nonexistent.authWrite'] })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidScope')
    // No key was minted.
    const count = await groupDb
      .selectFrom('group_api_keys')
      .select(groupDb.fn.countAll().as('n'))
      .executeTakeFirst()
    expect(Number(count!.n)).toBe(0)
  })
})
