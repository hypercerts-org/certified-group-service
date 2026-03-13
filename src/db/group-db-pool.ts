import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Kysely } from 'kysely'
import type { GroupDatabase } from './schema.js'
import { runGroupMigrations } from './migrate.js'
import { openSqliteDb } from './sqlite.js'

export class GroupDbPool {
  private dbs = new Map<string, Kysely<GroupDatabase>>()

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
  }

  get(groupDid: string): Kysely<GroupDatabase> {
    const existing = this.dbs.get(groupDid)
    if (existing) return existing

    const safeName = createHash('sha256').update(groupDid).digest('hex')
    const dbPath = join(this.dataDir, `${safeName}.sqlite`)

    const db = openSqliteDb<GroupDatabase>(dbPath)

    this.dbs.set(groupDid, db)
    return db
  }

  async migrateGroup(groupDid: string): Promise<void> {
    const db = this.get(groupDid)
    await runGroupMigrations(db)
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.dbs.values()].map((db) => db.destroy()))
    this.dbs.clear()
  }
}
