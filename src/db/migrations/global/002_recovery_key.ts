import { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .addColumn('encrypted_recovery_key', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .dropColumn('encrypted_recovery_key')
    .execute()
}
