import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

export interface SqliteDb<T> {
  db: Kysely<T>
  raw: Database.Database
}

export function openSqliteDb<T>(path: string): SqliteDb<T> {
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  const db = new Kysely<T>({
    dialect: new SqliteDialect({ database: raw }),
  })
  return { db, raw }
}
