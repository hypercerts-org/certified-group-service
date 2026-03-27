import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('member_index')
    .addColumn('member_did', 'text', (col) => col.notNull())
    .addColumn('group_did', 'text', (col) => col.notNull())
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('added_by', 'text', (col) => col.notNull())
    .addColumn('added_at', 'text', (col) =>
      col.defaultTo(sql`(datetime('now'))`).notNull(),
    )
    .addPrimaryKeyConstraint('pk_member_index', ['member_did', 'group_did'])
    .execute()

  await db.schema
    .createIndex('idx_member_index_group')
    .on('member_index')
    .columns(['group_did'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('member_index').ifExists().execute()
}
