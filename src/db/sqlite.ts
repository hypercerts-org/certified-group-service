import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

export interface SqliteDb<T> {
  db: Kysely<T>
  raw: Database.Database
}

/**
 * Backed by better-sqlite3, whose driver is **synchronous**: every query and
 * every `raw.transaction(...)` runs to completion on Node's single event-loop
 * turn, with no `await` inside it. This is load-bearing for concurrency
 * correctness across the service — a handler's DB statements cannot interleave
 * with another handler's mid-transaction; the only yield points are `await`
 * boundaries *between* DB calls. Several read-modify-write flows rely on this
 * (e.g. ownership transfer accepts while an out-of-band owner change races —
 * see `src/api/admin/setOwner.ts`). If this ever moves to an async driver
 * (`node:sqlite` worker threads, libsql, a connection pool with real
 * parallelism), those flows must be re-audited for interleaving.
 */
export function openSqliteDb<T>(path: string): SqliteDb<T> {
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  const db = new Kysely<T>({
    dialect: new SqliteDialect({ database: raw }),
  })
  return { db, raw }
}
