import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, createTestApp, mockAuth } from './helpers/mock-server.js'
import keysDeleteHandler from '../src/api/keys/delete.js'
import { generateApiKey } from '../src/auth/api-key.js'
import { scopeNeededFor } from '../src/auth/scopes.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const SERVICE_DID = 'did:web:test.example.com'
const SCOPE = scopeNeededFor('member.list', SERVICE_DID)!

function buildApp(ctx: AppContext) {
  return createTestApp(ctx, (server, appCtx) => keysDeleteHandler(server, appCtx))
}

async function seedKey(groupDb: Kysely<GroupDatabase>, name = 'k', createdBy = 'did:plc:owner') {
  const key = generateApiKey()
  await groupDb
    .insertInto('group_api_keys')
    .values({
      key_ref: key.keyRef,
      key_hash: key.hash,
      name,
      scopes: JSON.stringify([SCOPE]),
      created_by: createdBy,
    })
    .execute()
  return key
}

describe('keys.delete', () => {
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

  it('owner revokes a key (sets revoked_at)', async () => {
    const key = await seedKey(groupDb)
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(res.status).toBe(200)
    expect(res.body.keyRef).toBe(key.keyRef)
    expect(res.body.revokedAt).toBeTruthy()

    const row = await groupDb
      .selectFrom('group_api_keys')
      .select('revoked_at')
      .where('key_ref', '=', key.keyRef)
      .executeTakeFirst()
    expect(row?.revoked_at).not.toBeNull()
  })

  it('returns KeyNotFound for an unknown keyRef', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: 'does-not-exist' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('KeyNotFound')
  })

  it('is idempotent: re-deleting keeps the original revocation time', async () => {
    const key = await seedKey(groupDb)
    const first = await request(app)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    const second = await request(app)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(second.status).toBe(200)
    expect(second.body.revokedAt).toBe(first.body.revokedAt)
  })

  it('allows a non-owner member to revoke their own key', async () => {
    const test = await createTestContext()
    const memberDb = test.groupDb
    await seedMember(memberDb, 'did:plc:testuser', 'member')
    const key = await seedKey(memberDb, 'mine', 'did:plc:testuser')
    const memberApp = buildApp(test.ctx)
    const res = await request(memberApp)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(res.status).toBe(200)
    await memberDb.destroy()
  })

  it('rejects a non-owner member revoking someone else’s key', async () => {
    const test = await createTestContext()
    const memberDb = test.groupDb
    await seedMember(memberDb, 'did:plc:testuser', 'admin')
    const key = await seedKey(memberDb, 'not-mine', 'did:plc:owner')
    const memberApp = buildApp(test.ctx)
    const res = await request(memberApp)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(res.status).toBe(403)
    await memberDb.destroy()
  })

  it('owner can revoke another member’s key', async () => {
    const key = await seedKey(groupDb, 'member-key', 'did:plc:member')
    const res = await request(app)
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(res.status).toBe(200)
  })

  it('an API-key caller cannot revoke keys', async () => {
    const key = await seedKey(groupDb, 'mine', 'did:plc:testuser')
    ctx.authVerifier = {
      ...mockAuth('did:plc:testuser'),
      xrpcAuth() {
        return async () => ({
          credentials: {
            callerDid: 'did:plc:testuser',
            groupDid: 'did:plc:testgroup',
            legacyAud: false,
            authKind: 'apiKey',
            scopes: [`rpc:*?aud=${SERVICE_DID}%23certified_group_service`],
            apiKeyRef: 'ref1',
          },
        })
      },
    }
    const res = await request(buildApp(ctx))
      .post('/xrpc/app.certified.group.keys.delete')
      .send({ keyRef: key.keyRef })
    expect(res.status).toBe(403)
  })

  it('an empty/missing body is a 400, not a 500', async () => {
    const noBody = await request(app).post('/xrpc/app.certified.group.keys.delete')
    expect(noBody.status).toBe(400)
    const emptyObj = await request(app).post('/xrpc/app.certified.group.keys.delete').send({})
    expect(emptyObj.status).toBe(400)
  })

  it('concurrent deletes both succeed (200), sharing one revocation time', async () => {
    const key = await seedKey(groupDb)
    // Fire two revokes at once: one wins the UPDATE, the other matches 0 rows and
    // must re-read the winner's timestamp rather than 500.
    const [a, b] = await Promise.all([
      request(app).post('/xrpc/app.certified.group.keys.delete').send({ keyRef: key.keyRef }),
      request(app).post('/xrpc/app.certified.group.keys.delete').send({ keyRef: key.keyRef }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.revokedAt).toBe(b.body.revokedAt)
  })
})
