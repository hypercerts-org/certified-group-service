import { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('idx_members_added_at_did')
    .on('group_members')
    .columns(['added_at', 'member_did'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_members_added_at_did').ifExists().execute()
}
