import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
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

  get(groupDid: string): Kysely<GroupDatabase> {
    const existing = this.dbs.get(groupDid)
    if (existing) return existing

    const safeName = createHash('sha256').update(groupDid).digest('hex')
    const dbPath = join(this.dataDir, `${safeName}.sqlite`)

    const { db, raw } = openSqliteDb<GroupDatabase>(dbPath)

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

  async destroyAll(): Promise<void> {
    await Promise.all([...this.dbs.values()].map((db) => db.destroy()))
    this.dbs.clear()
    this.rawDbs.clear()
  }
}
