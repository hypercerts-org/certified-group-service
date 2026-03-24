import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Express } from 'express'
import request from 'supertest'
import { createTestContext, createTestApp, mockAuth, seedMember } from './helpers/mock-server.js'
import uploadBlobHandler from '../src/api/repo/uploadBlob.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

describe('uploadBlob', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: Express

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = { ...test.ctx, config: { ...test.ctx.config, maxBlobSize: 1024 } }
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'member')
    app = createTestApp(ctx, (server, appCtx) => {
      uploadBlobHandler(server, appCtx)
    })
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
    const overriddenCtx = { ...ctx, authVerifier: mockAuth('did:plc:stranger') }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      uploadBlobHandler(server, appCtx)
    })
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(10))
    expect(res.status).toBe(403)

    const logs = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(logs).toHaveLength(1)
    expect(logs[0].result).toBe('denied')
  })

  it('rejects blob exceeding Content-Length limit', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', '2000')
      .send(Buffer.alloc(10))
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('PayloadTooLarge')
  })

  it('rejects blob exceeding size mid-stream', async () => {
    // maxBlobSize is 1024, send 1025 bytes
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(1025))
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('PayloadTooLarge')
  })

  it('rejects request without Content-Type', async () => {
    // The XRPC server requires Content-Type for blob endpoints
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .unset('Content-Type')
      .send(Buffer.alloc(10))
    expect(res.status).toBe(400)
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
    const overriddenCtx = { ...ctx, pdsAgents: mockPdsAgents as any }
    app = createTestApp(overriddenCtx, (server, appCtx) => {
      uploadBlobHandler(server, appCtx)
    })

    await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'video/mp4')
      .send(Buffer.alloc(10))
    expect(capturedEncoding).toBe('video/mp4')
  })

  it('blob exactly at size limit is accepted', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(1024))
    expect(res.status).toBe(200)
  })
})
