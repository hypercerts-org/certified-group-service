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
