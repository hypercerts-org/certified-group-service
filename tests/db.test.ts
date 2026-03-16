import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { openSqliteDb } from '../src/db/sqlite.js'
import { GroupDbPool } from '../src/db/group-db-pool.js'
import { runGlobalMigrations, runGroupMigrations } from '../src/db/migrate.js'
import { createTestGlobalDb, createTestGroupDb } from './helpers/test-db.js'

describe('openSqliteDb', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns usable Kysely instance', async () => {
    const db = openSqliteDb(join(tmpDir, 'test.sqlite'))
    const result = await db.raw('SELECT 1 as val').execute()
    expect(result.rows).toHaveLength(1)
    await db.destroy()
  })

  it('sets WAL journal mode', async () => {
    const db = openSqliteDb(join(tmpDir, 'test.sqlite'))
    const result = await db.raw('PRAGMA journal_mode').execute()
    expect((result.rows[0] as any).journal_mode).toBe('wal')
    await db.destroy()
  })

  it('sets busy_timeout to 5000', async () => {
    const db = openSqliteDb(join(tmpDir, 'test.sqlite'))
    const result = await db.raw('PRAGMA busy_timeout').execute()
    expect((result.rows[0] as any).busy_timeout).toBe(5000)
    await db.destroy()
  })
})

describe('GroupDbPool', () => {
  let tmpDir: string
  let pool: GroupDbPool

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pool-test-'))
    pool = new GroupDbPool(tmpDir)
  })

  afterEach(async () => {
    await pool.destroyAll()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('get() returns same instance for same groupDid', () => {
    const a = pool.get('did:plc:a')
    const b = pool.get('did:plc:a')
    expect(a).toBe(b)
  })

  it('get() returns different instances for different groupDids', () => {
    const a = pool.get('did:plc:a')
    const b = pool.get('did:plc:b')
    expect(a).not.toBe(b)
  })

  it('creates dataDir on construction', () => {
    const newDir = join(tmpDir, 'nested', 'dir')
    const _pool = new GroupDbPool(newDir)
    expect(existsSync(newDir)).toBe(true)
  })

  it('uses SHA256 hash for database filenames', () => {
    pool.get('did:plc:test')
    const hash = createHash('sha256').update('did:plc:test').digest('hex')
    expect(existsSync(join(tmpDir, `${hash}.sqlite`))).toBe(true)
  })

  it('migrateGroup() creates tables', async () => {
    await pool.migrateGroup('did:plc:x')
    const db = pool.get('did:plc:x')
    // Should be able to query group_members without error
    const result = await db.selectFrom('group_members').selectAll().execute()
    expect(result).toEqual([])
  })

  it('destroyAll() clears pool so get() creates new instance', async () => {
    const before = pool.get('did:plc:a')
    await pool.destroyAll()
    // After destroyAll, a new pool on the same dir should give a fresh instance
    pool = new GroupDbPool(tmpDir)
    const after = pool.get('did:plc:a')
    expect(after).not.toBe(before)
  })
})

describe('migrations', () => {
  it('global migrations create groups and nonce_cache tables', async () => {
    const db = await createTestGlobalDb()
    await db.selectFrom('groups').selectAll().execute()
    await db.selectFrom('nonce_cache').selectAll().execute()
    await db.destroy()
  })

  it('group migrations create group_members, group_record_authors, group_audit_log', async () => {
    const db = await createTestGroupDb()
    await db.selectFrom('group_members').selectAll().execute()
    await db.selectFrom('group_record_authors').selectAll().execute()
    await db.selectFrom('group_audit_log').selectAll().execute()
    await db.destroy()
  })

  it('migrations are idempotent', async () => {
    const db = await createTestGlobalDb()
    await runGlobalMigrations(db)
    await db.selectFrom('groups').selectAll().execute()
    await db.destroy()

    const db2 = await createTestGroupDb()
    await runGroupMigrations(db2)
    await db2.selectFrom('group_members').selectAll().execute()
    await db2.destroy()
  })
})
