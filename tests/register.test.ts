import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, silentLogger } from './helpers/mock-server.js'
import groupRegisterHandler from '../src/api/group/register.js'
import { xrpcErrorHandler } from '../src/api/error-handler.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

// Mock AtpAgent — createAccount returns a DID, createAppPassword returns a password
vi.mock('@atproto/api', () => {
  return {
    AtpAgent: vi.fn().mockImplementation(() => ({
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
  app.use(xrpcErrorHandler(silentLogger as any))
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
    const test = await createTestContext()
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
    expect(res.body.accountPassword).toBeDefined()

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

  it('returns 400 for missing fields', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.register')
      .send({ handle: 'mygroup' })
    expect(res.status).toBe(400)
  })
})
