import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createHealthHandler } from '../src/health.js'
import { createTestGlobalDb } from './helpers/test-db.js'

// Pin the version so the body assertions are deterministic, independent of
// package.json / .cgs-version (see src/version.ts precedence).
const PINNED_VERSION = '9.9.9+testtest'

describe.each(['/health', '/xrpc/_health'])('GET %s', (path) => {
  let globalDb: Kysely<GlobalDatabase>
  let app: express.Express

  beforeEach(async () => {
    process.env.CGS_VERSION = PINNED_VERSION
    const testGlobal = await createTestGlobalDb()
    globalDb = testGlobal.db
    app = express()
    // Both routes share the same handler in production (src/index.ts).
    app.get(path, createHealthHandler(globalDb))
  })

  afterEach(async () => {
    delete process.env.CGS_VERSION
    try {
      await globalDb.destroy()
    } catch {}
  })

  it('returns 200 with status, service and version when DB is healthy', async () => {
    const res = await request(app).get(path)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'ok',
      service: 'group-service',
      version: PINNED_VERSION,
    })
  })

  it('returns 503 when DB is destroyed', async () => {
    await globalDb.destroy()
    const res = await request(app).get(path)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      status: 'error',
      message: 'database unreachable',
    })
  })
})
