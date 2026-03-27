import { describe, it, expect, beforeEach } from 'vitest'
import { NonceCache } from '../src/auth/nonce.js'
import { createTestGlobalDb } from './helpers/test-db.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'

describe('NonceCache', () => {
  let db: Kysely<GlobalDatabase>
  let cache: NonceCache

  beforeEach(async () => {
    const testGlobal = await createTestGlobalDb()
    db = testGlobal.db
    cache = new NonceCache(db)
  })

  it('returns true for new JTI', async () => {
    expect(await cache.checkAndStore('jti-1')).toBe(true)
  })

  it('returns false for replayed JTI', async () => {
    await cache.checkAndStore('jti-1')
    expect(await cache.checkAndStore('jti-1')).toBe(false)
  })

  it('cleanup removes expired entries', async () => {
    await db
      .insertInto('nonce_cache')
      .values({
        jti: 'old-jti',
        expires_at: '2020-01-01T00:00:00',
      })
      .execute()
    await cache.cleanup()
    expect(await cache.checkAndStore('old-jti')).toBe(true)
  })

  it('concurrent checkAndStore for same jti — only one wins', async () => {
    const results = await Promise.all([
      cache.checkAndStore('race-jti'),
      cache.checkAndStore('race-jti'),
    ])
    const trues = results.filter((r) => r === true)
    const falses = results.filter((r) => r === false)
    expect(trues).toHaveLength(1)
    expect(falses).toHaveLength(1)
  })

  it('cleanup preserves non-expired entries', async () => {
    await cache.checkAndStore('fresh-jti')
    await cache.cleanup()
    // fresh-jti should still be in cache (TTL=120s), so re-storing returns false
    expect(await cache.checkAndStore('fresh-jti')).toBe(false)
  })
})
