import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('group_api_keys')
    // Non-secret per-key id; the `<keyRef>` embedded in the key string.
    .addColumn('key_ref', 'text', (col) => col.primaryKey())
    // SHA-256 of the secret — never the plaintext.
    .addColumn('key_hash', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    // JSON array of @atproto/oauth-scopes scope strings.
    .addColumn('scopes', 'text', (col) => col.notNull())
    // Owner DID that minted the key.
    .addColumn('created_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    // Best-effort last-use timestamp; null until first use.
    .addColumn('last_used_at', 'text')
    // Soft-delete marker set by keys.delete; null while active.
    .addColumn('revoked_at', 'text')
    .execute()

  // keys.list pages active keys by recency; index the common filter+sort.
  await db.schema
    .createIndex('idx_api_keys_revoked_created')
    .on('group_api_keys')
    .columns(['revoked_at', 'created_at'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_api_keys_revoked_created').ifExists().execute()
  await db.schema.dropTable('group_api_keys').ifExists().execute()
}
