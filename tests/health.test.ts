import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createTestGlobalDb } from './helpers/test-db.js'

describe('GET /health', () => {
  let globalDb: Kysely<GlobalDatabase>
  let app: express.Express

  beforeEach(async () => {
    globalDb = await createTestGlobalDb()
    app = express()
    app.get('/health', async (_req, res) => {
      try {
        await globalDb.selectFrom('groups').select('did').limit(1).execute()
        res.json({ status: 'ok' })
      } catch {
        res.status(503).json({ status: 'error', message: 'database unreachable' })
      }
    })
  })

  afterEach(async () => {
    try { await globalDb.destroy() } catch {}
  })

  it('returns 200 when DB is healthy', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('returns 503 when DB is destroyed', async () => {
    await globalDb.destroy()
    const res = await request(app).get('/health')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'error', message: 'database unreachable' })
  })
})

describe('JSON parser skip for uploadBlob', () => {
  it('raw routes registered before JSON parser do not get body parsed', async () => {
    const app = express()

    // Raw route registered before JSON parser (mirrors registerRawRoutes)
    app.post('/xrpc/com.atproto.repo.uploadBlob', (req, res) => {
      res.json({ bodyParsed: req.body !== undefined })
    })

    // JSON parser applied after raw routes (mirrors index.ts)
    app.use(express.json({ limit: '1mb' }))

    // JSON route registered after parser (mirrors registerJsonRoutes)
    app.post('/xrpc/other', (req, res) => {
      res.json({ bodyParsed: req.body !== undefined })
    })

    const blobRes = await request(app)
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ foo: 'bar' }))
    expect(blobRes.body.bodyParsed).toBe(false)

    const otherRes = await request(app)
      .post('/xrpc/other')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ foo: 'bar' }))
    expect(otherRes.body.bodyParsed).toBe(true)
  })
})
