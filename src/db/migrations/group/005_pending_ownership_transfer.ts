import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pending_ownership_transfer')
    // A group has at most one pending transfer at a time. The CHECK-pinned
    // single-row `id` makes that a schema invariant: a second propose targets
    // the same row (INSERT OR REPLACE) rather than accumulating rows.
    .addColumn('id', 'integer', (col) => col.primaryKey().check(sql`id = 1`))
    // The current owner who proposed the transfer.
    .addColumn('proposer_did', 'text', (col) => col.notNull())
    // The member proposed as the new owner; only they may accept.
    .addColumn('recipient_did', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    // Absolute expiry, computed at propose time as datetime('now','+N seconds').
    // Enforced lazily on read (a row past expiry is treated as absent); no sweeper.
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pending_ownership_transfer').ifExists().execute()
}
