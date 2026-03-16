import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestContext, seedMember, silentLogger } from './helpers/mock-server.js'
import uploadBlobHandler from '../src/api/repo/uploadBlob.js'
import { xrpcErrorHandler } from '../src/api/error-handler.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

function createApp(ctx: AppContext) {
  const app = express()
  // No express.json() — uploadBlob reads raw stream
  uploadBlobHandler(app, ctx)
  app.use(xrpcErrorHandler(silentLogger as any))
  return app
}

describe('uploadBlob', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = { ...test.ctx, config: { ...test.ctx.config, maxBlobSize: 1024 } }
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createApp(ctx)
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('uploads blob and returns PDS response', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(100))
    expect(res.status).toBe(200)
    expect(res.body.blob).toBeDefined()

    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('uploadBlob')
    expect(logs[0].result).toBe('permitted')
  })

  it('rejects non-member', async () => {
    app = createApp({
      ...ctx,
      authVerifier: { verify: async () => ({ iss: 'did:plc:stranger', aud: 'did:plc:testgroup' }) } as any,
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .send(Buffer.alloc(10))
    expect(res.status).toBe(401)

    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
  })

  it('rejects blob exceeding Content-Length limit', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Length', '2000')
      .send(Buffer.alloc(10))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('BlobTooLarge')
  })

  it('rejects blob exceeding size mid-stream', async () => {
    // maxBlobSize is 1024, send 1025 bytes
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .send(Buffer.alloc(1025))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('BlobTooLarge')
  })

  it('defaults Content-Type to application/octet-stream', async () => {
    let capturedEncoding: string | undefined
    const mockPdsAgents = {
      ...ctx.pdsAgents,
      withAgent: async (_did: string, fn: (agent: any) => Promise<any>) => {
        const agent = {
          com: { atproto: { repo: {
            uploadBlob: async (_data: any, opts: any) => {
              capturedEncoding = opts.encoding
              return { data: { blob: { ref: { $link: 'bafyblob' }, mimeType: 'application/octet-stream', size: 10 } } }
            },
          } } },
        }
        return fn(agent)
      },
    }
    app = createApp({ ...ctx, pdsAgents: mockPdsAgents as any })

    await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .unset('Content-Type')
      .send(Buffer.alloc(10))
    expect(capturedEncoding).toBe('application/octet-stream')
  })

  it('preserves custom Content-Type', async () => {
    let capturedEncoding: string | undefined
    const mockPdsAgents = {
      ...ctx.pdsAgents,
      withAgent: async (_did: string, fn: (agent: any) => Promise<any>) => {
        const agent = {
          com: { atproto: { repo: {
            uploadBlob: async (_data: any, opts: any) => {
              capturedEncoding = opts.encoding
              return { data: { blob: { ref: { $link: 'bafyblob' }, mimeType: 'video/mp4', size: 10 } } }
            },
          } } },
        }
        return fn(agent)
      },
    }
    app = createApp({ ...ctx, pdsAgents: mockPdsAgents as any })

    await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'video/mp4')
      .send(Buffer.alloc(10))
    expect(capturedEncoding).toBe('video/mp4')
  })

  it('blob exactly at size limit is accepted', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .send(Buffer.alloc(1024))
    expect(res.status).toBe(200)
  })
})
