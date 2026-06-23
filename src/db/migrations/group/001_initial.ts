import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('group_members')
    .addColumn('member_did', 'text', (col) => col.primaryKey())
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('added_by', 'text', (col) => col.notNull())
    .addColumn('added_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    .execute()

  await db.schema
    .createTable('group_record_authors')
    .addColumn('record_uri', 'text', (col) => col.primaryKey())
    .addColumn('author_did', 'text', (col) => col.notNull())
    .addColumn('collection', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    .execute()

  await db.schema
    .createIndex('idx_record_authors_author')
    .on('group_record_authors')
    .columns(['author_did'])
    .execute()

  await db.schema
    .createTable('group_audit_log')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('actor_did', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('collection', 'text')
    .addColumn('rkey', 'text')
    .addColumn('result', 'text', (col) => col.notNull())
    .addColumn('detail', 'text')
    .addColumn('jti', 'text')
    .addColumn('created_at', 'text', (col) => col.defaultTo(sql`(datetime('now'))`).notNull())
    .execute()

  await db.schema
    .createIndex('idx_audit_log_created')
    .on('group_audit_log')
    .columns(['created_at'])
    .execute()

  await db.schema
    .createIndex('idx_audit_log_actor')
    .on('group_audit_log')
    .columns(['actor_did'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('group_audit_log').ifExists().execute()
  await db.schema.dropTable('group_record_authors').ifExists().execute()
  await db.schema.dropTable('group_members').ifExists().execute()
}
