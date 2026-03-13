import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { runGlobalMigrations, runGroupMigrations } from '../../src/db/migrate.js'
import type { GlobalDatabase, GroupDatabase } from '../../src/db/schema.js'

export async function createTestGlobalDb(): Promise<Kysely<GlobalDatabase>> {
  const sqliteDb = new Database(':memory:')
  const db = new Kysely<GlobalDatabase>({
    dialect: new SqliteDialect({ database: sqliteDb }),
  })
  await runGlobalMigrations(db)
  return db
}

export async function createTestGroupDb(): Promise<Kysely<GroupDatabase>> {
  const sqliteDb = new Database(':memory:')
  const db = new Kysely<GroupDatabase>({
    dialect: new SqliteDialect({ database: sqliteDb }),
  })
  await runGroupMigrations(db)
  return db
}
