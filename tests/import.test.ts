import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AuthRequiredError } from '@atproto/xrpc-server'
import {
  createTestContext,
  createTestApp,
  mockAuth,
  mockIdResolver,
} from './helpers/mock-server.js'
import groupImportHandler from '../src/api/group/import.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

// Mock AtpAgent — import only logs in (no account creation). Default: success.
vi.mock('@atproto/api', () => {
  return {
    AtpAgent: vi.fn().mockImplementation(() => ({
      login: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

import { AtpAgent } from '@atproto/api'

const ENDPOINT = '/xrpc/app.certified.group.import'

const validBody = {
  groupDid: 'did:plc:existingaccount',
  appPassword: 'abcd-efgh-ijkl-mnop',
  ownerDid: 'did:plc:owner',
}

describe('group.import', () => {
  let ctx: AppContext
  let globalDb: Kysely<GlobalDatabase>
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    vi.clearAllMocks()
    const test = await createTestContext({
      // The JWT is signed by the account being imported (iss = groupDid);
      // idResolver resolves to the test PDS by default. ownerDid (the grantee)
      // may differ and is not separately authenticated.
      authVerifier: mockAuth('did:plc:existingaccount'),
    })
    ctx = test.ctx
    globalDb = test.globalDb
    groupDb = test.groupDb
    app = createTestApp(ctx, groupImportHandler)
  })

  afterEach(async () => {
    await globalDb.destroy()
    await groupDb.destroy()
  })

  it('imports an existing account and registers the group', async () => {
    const res = await request(app).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(200)
    expect(res.body.groupDid).toBe('did:plc:existingaccount')
    expect(res.body.handle).toBe('imported.pds.example.com')

    // Logged in to the resolved PDS with the supplied app password
    const mockAgent = vi.mocked(AtpAgent).mock.results[0].value
    expect(mockAgent.login).toHaveBeenCalledWith({
      identifier: 'did:plc:existingaccount',
      password: 'abcd-efgh-ijkl-mnop',
    })

    // Group stored in global DB with the resolved PDS and NO recovery key
    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeDefined()
    expect(group!.pds_url).toBe('https://pds.example.com')
    expect(group!.encrypted_app_password).toBeDefined()
    expect(group!.encrypted_recovery_key).toBeNull()
  })

  it('seeds the supplied ownerDid as owner (may differ from the signing groupDid)', async () => {
    const res = await request(app).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(200)

    const owner = await groupDb
      .selectFrom('group_members')
      .where('member_did', '=', 'did:plc:owner')
      .selectAll()
      .executeTakeFirst()
    expect(owner).toBeDefined()
    expect(owner!.role).toBe('owner')
  })

  it('stores the resolved PDS url, not the configured group PDS', async () => {
    // Resolve the account to a different PDS than config.groupPdsUrl
    const test = await createTestContext({
      authVerifier: mockAuth('did:plc:existingaccount'),
      idResolver: mockIdResolver('https://other-pds.example.net'),
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(200)

    const mockAgent = vi.mocked(AtpAgent).mock.results.at(-1)!.value
    expect(mockAgent.login).toHaveBeenCalled()

    const group = await test.globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group!.pds_url).toBe('https://other-pds.example.net')

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('rejects a non-https resolved PDS endpoint', async () => {
    // We never POST the app password over cleartext http. (atproto's resolver
    // already guarantees the value parses as http(s); we add the https check.)
    const test = await createTestContext({
      authVerifier: mockAuth('did:plc:existingaccount'),
      idResolver: mockIdResolver('http://pds.example.com'),
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(400)
    // Never attempted a login against the http endpoint, nothing persisted
    expect(AtpAgent).not.toHaveBeenCalled()
    const group = await test.globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('returns 400 when the DID document has no PDS endpoint', async () => {
    const test = await createTestContext({
      authVerifier: mockAuth('did:plc:existingaccount'),
      idResolver: {
        did: {
          resolveAtprotoData: async (did: string) => ({
            did,
            signingKey: 'did:key:zMock',
            handle: 'x.example.com',
            pds: undefined,
          }),
        },
      } as any,
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(400)
    expect(AtpAgent).not.toHaveBeenCalled()

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('returns 400 when the groupDid DID document cannot be resolved', async () => {
    const test = await createTestContext({
      authVerifier: mockAuth('did:plc:existingaccount'),
      idResolver: {
        did: {
          resolveAtprotoData: async () => {
            throw new Error('DID not found')
          },
        },
      } as any,
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('Could not resolve DID document')

    // Failed before any PDS login or persistence
    expect(AtpAgent).not.toHaveBeenCalled()
    const group = await test.globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('returns InvalidAppPassword when login fails (bad/revoked credential)', async () => {
    vi.mocked(AtpAgent).mockImplementationOnce(
      () =>
        ({
          login: vi.fn().mockRejectedValue(
            Object.assign(new Error('Invalid identifier or password'), {
              status: 401,
              error: 'AuthenticationRequired',
            }),
          ),
        }) as any,
    )

    const res = await request(app).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('InvalidAppPassword')

    // Nothing persisted on failure
    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()
  })

  it('does not mask a non-auth PDS error as InvalidAppPassword', async () => {
    // A 5xx from the account's PDS is an upstream failure, not a bad password;
    // the handler rethrows it rather than reporting InvalidAppPassword.
    vi.mocked(AtpAgent).mockImplementationOnce(
      () =>
        ({
          login: vi.fn().mockRejectedValue(
            Object.assign(new Error('PDS unavailable'), {
              status: 502,
              error: 'UpstreamFailure',
            }),
          ),
        }) as any,
    )

    const res = await request(app).post(ENDPOINT).send(validBody)
    expect(res.status).not.toBe(200)
    expect(res.body.error).not.toBe('InvalidAppPassword')

    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()
  })

  it('returns GroupAlreadyRegistered when the group already exists', async () => {
    const first = await request(app).post(ENDPOINT).send(validBody)
    expect(first.status).toBe(200)

    const second = await request(app).post(ENDPOINT).send(validBody)
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('GroupAlreadyRegistered')
  })

  it('returns 400 for missing fields', async () => {
    const res = await request(app).post(ENDPOINT).send({ groupDid: 'did:plc:existingaccount' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid groupDid', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ ...validBody, groupDid: 'not-a-did' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid ownerDid', async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ ...validBody, ownerDid: 'not-a-did' })
    expect(res.status).toBe(400)
  })

  it('rejects when the auth issuer does not match groupDid', async () => {
    const test = await createTestContext({
      // Caller signs as some unrelated DID, not the account being imported
      authVerifier: mockAuth('did:plc:someoneelse'),
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(401)

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('rejects when only the grantee (ownerDid) signs, not groupDid', async () => {
    // Authenticate as the recipient of ownership rather than the account being
    // imported. Under option a we gate on the grantor (iss = groupDid), so
    // proving control of ownerDid alone is not sufficient.
    const test = await createTestContext({
      authVerifier: mockAuth('did:plc:owner'),
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(401)

    // Nothing persisted on rejection
    const group = await test.globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:existingaccount')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('rejects unauthenticated requests', async () => {
    const test = await createTestContext({
      authVerifier: {
        ...mockAuth('did:plc:owner'),
        verifyServiceAuth: async () => {
          throw new AuthRequiredError('Missing auth token')
        },
      },
    })
    const otherApp = createTestApp(test.ctx, groupImportHandler)

    const res = await request(otherApp).post(ENDPOINT).send(validBody)
    expect(res.status).toBe(401)

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })
})
