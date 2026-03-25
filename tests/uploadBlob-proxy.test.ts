import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createTestContext, createTestApp, seedMember } from './helpers/mock-server.js'
import uploadBlobHandler from '../src/api/repo/uploadBlob.js'
import { PdsAgentPool } from '../src/pds/agent.js'
import { encrypt } from '../src/pds/credentials.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

describe('uploadBlob proxy (real PDS agent)', () => {
  let pds: http.Server
  let pdsPort: number
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeAll(async () => {
    // Spin up a tiny mock PDS
    pds = http.createServer((req, res) => {
      if (req.url?.includes('createSession')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          did: 'did:plc:testgroup',
          handle: 'test.handle',
          accessJwt: 'fake-jwt',
          refreshJwt: 'fake-refresh',
        }))
      }
      if (req.url?.includes('uploadBlob')) {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          const size = Buffer.concat(chunks).length
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            blob: {
              $type: 'blob',
              ref: { $link: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
              mimeType: req.headers['content-type'] || 'application/octet-stream',
              size,
            },
          }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => pds.listen(0, resolve))
    pdsPort = (pds.address() as AddressInfo).port
  })

  afterAll(() => {
    pds.close()
  })

  beforeEach(async () => {
    const test = await createTestContext()
    const globalDb = test.globalDb

    // Register group with PDS URL pointing at mock PDS
    const encKey = Buffer.from('a'.repeat(64), 'hex')
    const encPw = encrypt('test-password', encKey)
    await globalDb
      .insertInto('groups')
      .values({
        did: 'did:plc:testgroup',
        pds_url: `http://localhost:${pdsPort}`,
        encrypted_app_password: encPw,
      })
      .execute()

    // Replace PDS agent pool with a real one pointing at mock PDS
    const pdsAgents = new PdsAgentPool(globalDb, encKey)

    ctx = {
      ...test.ctx,
      config: { ...test.ctx.config, maxBlobSize: 10 * 1024 * 1024 },
      pdsAgents: pdsAgents as any,
    }
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    app = createTestApp(ctx, (server, appCtx) => {
      uploadBlobHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('proxies uploadBlob through real PDS agent (supertest)', async () => {
    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(100))

    expect(res.status).toBe(200)
    expect(res.body.blob).toBeDefined()
    expect(res.body.blob.ref).toBeDefined()
    expect(res.body.blob.mimeType).toBe('image/png')
  })

  it('proxies uploadBlob via real HTTP (like integration test)', async () => {
    const server = app.listen(0)
    const cgsPort = (server.address() as AddressInfo).port

    try {
      const pngData = Buffer.from(
        '89504e470d0a1a0a0000000d494844520000000100000001080200000090' +
          '77533800000000c49444154789c6260f8cfc00000000200016e0065400000' +
          '0000049454e44ae426082',
        'hex',
      )
      const res = await fetch(`http://localhost:${cgsPort}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: pngData,
      })

      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.blob).toBeDefined()
    } finally {
      server.close()
    }
  })

  it('proxies via certified NSID too', async () => {
    const res = await request(app)
      .post('/xrpc/app.certified.group.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(50))

    expect(res.status).toBe(200)
    expect(res.body.blob).toBeDefined()
  })
})

describe('uploadBlob proxy (PDS error scenarios)', () => {
  let groupDb: Kysely<GroupDatabase>

  afterEach(async () => {
    await groupDb.destroy()
  })

  async function buildAppWithPds(pdsUrl: string) {
    const test = await createTestContext()
    const encKey = Buffer.from('a'.repeat(64), 'hex')
    await test.globalDb.insertInto('groups').values({
      did: 'did:plc:testgroup',
      pds_url: pdsUrl,
      encrypted_app_password: encrypt('pw', encKey),
    }).execute()
    groupDb = test.groupDb
    await seedMember(groupDb, 'did:plc:testuser', 'owner')

    const ctx = {
      ...test.ctx,
      pdsAgents: new PdsAgentPool(test.globalDb, encKey) as any,
    }
    return createTestApp(ctx, (server, appCtx) => {
      uploadBlobHandler(server, appCtx)
    })
  }

  it('PDS 500 propagates as 500', async () => {
    const pds = http.createServer((req, res) => {
      if (req.url?.includes('createSession')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          did: 'did:plc:testgroup', handle: 'test', accessJwt: 'j', refreshJwt: 'r',
        }))
      }
      // Consume body then return error
      req.resume()
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'InternalServerError', message: 'PDS broke' }))
      })
    })
    await new Promise<void>((r) => pds.listen(0, r))
    const port = (pds.address() as AddressInfo).port

    const app = await buildAppWithPds(`http://localhost:${port}`)

    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(10))

    pds.close()
    // PDS errors should surface as 502 (upstream failure), not leak through as 500
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('UpstreamFailure')
  })

  it('PDS connection refused becomes 502', async () => {
    const app = await buildAppWithPds('http://localhost:1')

    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(10))

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('UpstreamFailure')
  })

  it('PDS login failure becomes 502 (not leaked 401)', async () => {
    const pds = http.createServer((req, res) => {
      if (req.url?.includes('createSession')) {
        req.resume()
        req.on('end', () => {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => pds.listen(0, r))
    const port = (pds.address() as AddressInfo).port

    const app = await buildAppWithPds(`http://localhost:${port}`)

    const res = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(10))

    pds.close()
    // PDS auth failure should NOT leak as 401 to the CGS client
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('UpstreamFailure')
  })
})
