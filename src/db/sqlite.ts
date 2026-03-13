import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

export function openSqliteDb<T>(path: string): Kysely<T> {
  const sqliteDb = new Database(path)
  sqliteDb.pragma('journal_mode = WAL')
  sqliteDb.pragma('busy_timeout = 5000')
  return new Kysely<T>({
    dialect: new SqliteDialect({ database: sqliteDb }),
  })
}
