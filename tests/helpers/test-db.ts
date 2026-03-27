import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { runGlobalMigrations, runGroupMigrations } from '../../src/db/migrate.js'
import type { GlobalDatabase, GroupDatabase } from '../../src/db/schema.js'

export async function createTestGlobalDb(): Promise<{ db: Kysely<GlobalDatabase>; raw: Database.Database }> {
  const raw = new Database(':memory:')
  const db = new Kysely<GlobalDatabase>({
    dialect: new SqliteDialect({ database: raw }),
  })
  await runGlobalMigrations(db)
  return { db, raw }
}

export async function createTestGroupDb(): Promise<{ db: Kysely<GroupDatabase>; raw: Database.Database }> {
  const raw = new Database(':memory:')
  const db = new Kysely<GroupDatabase>({
    dialect: new SqliteDialect({ database: raw }),
  })
  await runGroupMigrations(db)
  return { db, raw }
}
