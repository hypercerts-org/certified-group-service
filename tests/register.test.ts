import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AuthRequiredError } from '@atproto/xrpc-server'
import { createTestContext, silentLogger } from './helpers/mock-server.js'
import groupRegisterHandler from '../src/api/group/register.js'
import { createFallbackErrorHandler } from '../src/api/error-handler.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

// Mock AtpAgent — createAccount returns a DID, createAppPassword returns a password
vi.mock('@atproto/api', () => {
  return {
    AtpAgent: vi.fn().mockImplementation(() => ({
      resumeSession: vi.fn().mockResolvedValue(undefined),
      com: {
        atproto: {
          server: {
            createAccount: vi.fn().mockResolvedValue({
              data: { did: 'did:plc:newgroup', handle: 'mygroup.pds.example.com', accessJwt: 'jwt', refreshJwt: 'rjwt' },
            }),
            createAppPassword: vi.fn().mockResolvedValue({
              data: { name: 'group-service', password: 'app-pass-xxxx' },
            }),
          },
          identity: {
            getRecommendedDidCredentials: vi.fn().mockResolvedValue({
              data: { rotationKeys: ['did:key:z...'], verificationMethods: {}, services: {} },
            }),
            signPlcOperation: vi.fn().mockResolvedValue({
              data: { operation: { type: 'plc_operation', sig: 'mock' } },
            }),
            submitPlcOperation: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    })),
  }
})

import { AtpAgent } from '@atproto/api'

function createApp(ctx: AppContext) {
  const app = express()
  app.use(express.json())
  groupRegisterHandler(app, ctx)
  app.use(createFallbackErrorHandler(silentLogger as any))
  return app
}

const validBody = {
  handle: 'mygroup',
  ownerDid: 'did:plc:owner',
}

describe('group.register', () => {
  let ctx: AppContext
  let globalDb: Kysely<GlobalDatabase>
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    vi.clearAllMocks()
    const test = await createTestContext({
      authVerifier: {
        verify: async () => ({ iss: 'did:plc:owner', aud: 'did:plc:testgroup' }),
        verifyRegistration: async () => ({ iss: 'did:plc:owner' }),
        xrpcAuth() {
          return async () => ({
            credentials: { callerDid: 'did:plc:owner', groupDid: 'did:plc:testgroup' },
          })
        },
      } as any,
    })
    ctx = test.ctx
    globalDb = test.globalDb
    groupDb = test.groupDb
    app = createApp(ctx)
  })

  afterEach(async () => {
    await globalDb.destroy()
    await groupDb.destroy()
  })

  it('creates account on group PDS and registers the group', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(200)
    expect(res.body.groupDid).toBe('did:plc:newgroup')
    expect(res.body.handle).toBe('mygroup.pds.example.com')
    expect(res.body.accountPassword).toBeUndefined()

    // Verify group stored in global DB
    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:newgroup')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeDefined()
    expect(group!.pds_url).toBe('https://pds.example.com')
    expect(group!.encrypted_app_password).toBeDefined()

    // Verify owner seeded in group DB
    const owner = await groupDb
      .selectFrom('group_members')
      .where('member_did', '=', 'did:plc:owner')
      .selectAll()
      .executeTakeFirst()
    expect(owner).toBeDefined()
    expect(owner!.role).toBe('owner')
  })

  it('returns error when PDS account creation fails', async () => {
    vi.mocked(AtpAgent).mockImplementationOnce(() => ({
      resumeSession: vi.fn().mockResolvedValue(undefined),
      com: {
        atproto: {
          server: {
            createAccount: vi.fn().mockRejectedValue(
              Object.assign(new Error('Handle taken'), { status: 400, error: 'HandleNotAvailable' }),
            ),
            createAppPassword: vi.fn(),
          },
        },
      },
    }) as any)

    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('HandleNotAvailable')
  })

  it('returns 400 for invalid ownerDid', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send({ ...validBody, ownerDid: 'not-a-did' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid handle characters', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send({ ...validBody, handle: 'my group!' })
    expect(res.status).toBe(400)
  })

  it('passes caller-provided email to createAccount', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send({ ...validBody, email: 'owner@example.com' })
    expect(res.status).toBe(200)

    const mockAgent = vi.mocked(AtpAgent).mock.results[0].value
    const createAccountCall = mockAgent.com.atproto.server.createAccount.mock.calls[0][0]
    expect(createAccountCall.email).toBe('owner@example.com')
  })

  it('uses placeholder email when none provided', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(200)

    const mockAgent = vi.mocked(AtpAgent).mock.results[0].value
    const createAccountCall = mockAgent.com.atproto.server.createAccount.mock.calls[0][0]
    expect(createAccountCall.email).toBe('mygroup@group.pds.example.com')
  })

  it('returns 400 for missing fields', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send({ handle: 'mygroup' })
    expect(res.status).toBe(400)
  })

  it('rejects unauthenticated requests', async () => {
    const test = await createTestContext({
      authVerifier: {
        verify: async () => ({ iss: 'did:plc:owner', aud: 'did:plc:testgroup' }),
        verifyRegistration: async () => {
          throw new AuthRequiredError('Missing auth token')
        },
        xrpcAuth() {
          return async () => ({
            credentials: { callerDid: 'did:plc:owner', groupDid: 'did:plc:testgroup' },
          })
        },
      } as any,
    })
    const unauthApp = createApp(test.ctx)

    const res = await request(unauthApp)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(401)

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('rejects when token issuer does not match ownerDid', async () => {
    const test = await createTestContext({
      authVerifier: {
        verify: async () => ({ iss: 'did:plc:attacker', aud: 'did:plc:testgroup' }),
        verifyRegistration: async () => ({ iss: 'did:plc:attacker' }),
        xrpcAuth() {
          return async () => ({
            credentials: { callerDid: 'did:plc:attacker', groupDid: 'did:plc:testgroup' },
          })
        },
      } as any,
    })
    const mismatchApp = createApp(test.ctx)

    const res = await request(mismatchApp)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(401)
    expect(res.body.message).toContain('does not match ownerDid')

    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  it('registers service endpoint in DID document during registration', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(200)

    const mockAgent = vi.mocked(AtpAgent).mock.results[0].value
    expect(mockAgent.com.atproto.identity.getRecommendedDidCredentials).toHaveBeenCalled()
    expect(mockAgent.com.atproto.identity.signPlcOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({
          certified_group: {
            type: 'CertifiedGroupService',
            endpoint: 'https://test.example.com',
          },
        }),
      }),
    )
    expect(mockAgent.com.atproto.identity.submitPlcOperation).toHaveBeenCalledWith({
      operation: { type: 'plc_operation', sig: 'mock' },
    })
  })

  it('fails registration if PLC operation fails', async () => {
    vi.mocked(AtpAgent).mockImplementationOnce(() => ({
      resumeSession: vi.fn().mockResolvedValue(undefined),
      com: {
        atproto: {
          server: {
            createAccount: vi.fn().mockResolvedValue({
              data: { did: 'did:plc:newgroup', handle: 'mygroup.pds.example.com', accessJwt: 'jwt', refreshJwt: 'rjwt' },
            }),
            createAppPassword: vi.fn(),
          },
          identity: {
            getRecommendedDidCredentials: vi.fn().mockResolvedValue({
              data: { rotationKeys: ['did:key:z...'], verificationMethods: {}, services: {} },
            }),
            signPlcOperation: vi.fn().mockRejectedValue(new Error('PLC operation failed')),
            submitPlcOperation: vi.fn(),
          },
        },
      },
    }) as any)

    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send(validBody)
    expect(res.status).toBe(500)

    const group = await globalDb
      .selectFrom('groups')
      .where('did', '=', 'did:plc:newgroup')
      .selectAll()
      .executeTakeFirst()
    expect(group).toBeUndefined()
  })
})
