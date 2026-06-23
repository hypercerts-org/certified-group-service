import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, createTestApp } from './helpers/mock-server.js'
import keysListHandler from '../src/api/keys/list.js'
import { generateApiKey } from '../src/auth/api-key.js'
import { scopeNeededFor } from '../src/auth/scopes.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const SERVICE_DID = 'did:web:test.example.com'
const SCOPE = scopeNeededFor('member.list', SERVICE_DID)!

function buildApp(ctx: AppContext) {
  return createTestApp(ctx, (server, appCtx) => keysListHandler(server, appCtx))
}

async function seedKey(
  groupDb: Kysely<GroupDatabase>,
  name: string,
  opts: { revoked?: boolean } = {},
) {
  const key = generateApiKey()
  await groupDb
    .insertInto('group_api_keys')
    .values({
      key_ref: key.keyRef,
      key_hash: key.hash,
      name,
      scopes: JSON.stringify([SCOPE]),
      created_by: 'did:plc:owner',
      revoked_at: opts.revoked ? '2020-01-01 00:00:00' : null,
    })
    .execute()
  return key
}

describe('keys.list', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    app = buildApp(ctx)
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('owner lists active keys without secret or hash', async () => {
    await seedKey(groupDb, 'key-a')
    const res = await request(app).get('/xrpc/app.certified.group.keys.list')
    expect(res.status).toBe(200)
    expect(res.body.keys).toHaveLength(1)
    const k = res.body.keys[0]
    expect(k.name).toBe('key-a')
    expect(k.scopes).toEqual([SCOPE])
    expect(k.createdBy).toBe('did:plc:owner')
    expect(k.keyRef).toBeTruthy()
    // Never leak secret material.
    expect(k).not.toHaveProperty('key')
    expect(k).not.toHaveProperty('key_hash')
    expect(k).not.toHaveProperty('keyHash')
    expect(JSON.stringify(res.body)).not.toContain('cgsk_')
  })

  it('excludes revoked keys by default; includes them with includeRevoked', async () => {
    await seedKey(groupDb, 'active')
    await seedKey(groupDb, 'revoked', { revoked: true })

    const def = await request(app).get('/xrpc/app.certified.group.keys.list')
    expect(def.body.keys.map((k: { name: string }) => k.name)).toEqual(['active'])

    const all = await request(app).get('/xrpc/app.certified.group.keys.list?includeRevoked=true')
    const names = all.body.keys.map((k: { name: string }) => k.name).sort()
    expect(names).toEqual(['active', 'revoked'])
    const revoked = all.body.keys.find((k: { name: string }) => k.name === 'revoked')
    expect(revoked.revokedAt).toBeTruthy()
  })

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 3; i++) await seedKey(groupDb, `key-${i}`)
    const page1 = await request(app).get('/xrpc/app.certified.group.keys.list?limit=2')
    expect(page1.body.keys).toHaveLength(2)
    expect(page1.body.cursor).toBeTruthy()

    const page2 = await request(app).get(
      `/xrpc/app.certified.group.keys.list?limit=2&cursor=${encodeURIComponent(page1.body.cursor)}`,
    )
    expect(page2.body.keys).toHaveLength(1)
    expect(page2.body.cursor).toBeUndefined()

    // No overlap across pages.
    const refs = new Set([
      ...page1.body.keys.map((k: { keyRef: string }) => k.keyRef),
      ...page2.body.keys.map((k: { keyRef: string }) => k.keyRef),
    ])
    expect(refs.size).toBe(3)
  })

  it('rejects a non-owner (admin) with Forbidden', async () => {
    const test = await createTestContext()
    const adminGroupDb = test.groupDb
    await seedMember(adminGroupDb, 'did:plc:testuser', 'admin')
    const adminApp = buildApp(test.ctx)
    const res = await request(adminApp).get('/xrpc/app.certified.group.keys.list')
    expect(res.status).toBe(403)
    await adminGroupDb.destroy()
  })
})
