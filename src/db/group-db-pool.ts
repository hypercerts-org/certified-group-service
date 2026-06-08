import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Kysely } from 'kysely'
import type Database from 'better-sqlite3'
import type { GroupDatabase } from './schema.js'
import { runGroupMigrations } from './migrate.js'
import { openSqliteDb } from './sqlite.js'

export class GroupDbPool {
  private dbs = new Map<string, Kysely<GroupDatabase>>()
  private rawDbs = new Map<string, Database.Database>()

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
  }

  /** Path of the per-group SQLite file for a DID (SHA256-hashed filename). */
  private dbPath(groupDid: string): string {
    const safeName = createHash('sha256').update(groupDid).digest('hex')
    return join(this.dataDir, `${safeName}.sqlite`)
  }

  get(groupDid: string): Kysely<GroupDatabase> {
    const existing = this.dbs.get(groupDid)
    if (existing) return existing

    const { db, raw } = openSqliteDb<GroupDatabase>(this.dbPath(groupDid))

    this.dbs.set(groupDid, db)
    this.rawDbs.set(groupDid, raw)
    return db
  }

  getRaw(groupDid: string): Database.Database {
    // Ensure the DB is opened first
    this.get(groupDid)
    return this.rawDbs.get(groupDid)!
  }

  async migrateGroup(groupDid: string): Promise<void> {
    const db = this.get(groupDid)
    await runGroupMigrations(db)
  }

  /**
   * Close any open handles for a single group and delete its SQLite file.
   * Irreversible — used by group.destroy. The caller is responsible for
   * removing the group's global-DB state (groups row, member_index) first; this
   * only tears down the per-group file. Safe to call when no handle is open and
   * idempotent if the file is already gone (rmSync with force).
   */
  async destroyGroup(groupDid: string): Promise<void> {
    const db = this.dbs.get(groupDid)
    if (db) await db.destroy()
    this.dbs.delete(groupDid)
    this.rawDbs.delete(groupDid)
    rmSync(this.dbPath(groupDid), { force: true })
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.dbs.values()].map((db) => db.destroy()))
    this.dbs.clear()
    this.rawDbs.clear()
  }
}
