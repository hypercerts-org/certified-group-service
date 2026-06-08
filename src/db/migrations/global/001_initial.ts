import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('groups')
    .addColumn('did', 'text', (col) => col.primaryKey())
    .addColumn('pds_url', 'text', (col) => col.notNull())
    .addColumn('encrypted_app_password', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    .execute()

  await db.schema
    .createTable('nonce_cache')
    .addColumn('jti', 'text', (col) => col.primaryKey())
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .execute()

  await db.schema
    .createIndex('idx_nonce_cache_expires')
    .on('nonce_cache')
    .columns(['expires_at'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('nonce_cache').ifExists().execute()
  await db.schema.dropTable('groups').ifExists().execute()
}
