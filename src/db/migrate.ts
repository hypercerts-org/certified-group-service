import { Migrator, FileMigrationProvider } from 'kysely'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from './schema.js'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

async function runMigrations(db: Kysely<unknown>, folder: string): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: { join },
      migrationFolder: join(migrationsDir, folder),
    }),
  })
  const { error } = await migrator.migrateToLatest()
  if (error) {
    throw error instanceof Error ? error : new Error(JSON.stringify(error))
  }
}

export async function runGlobalMigrations(db: Kysely<GlobalDatabase>): Promise<void> {
  await runMigrations(db as Kysely<unknown>, 'global')
}

export async function runGroupMigrations(db: Kysely<GroupDatabase>): Promise<void> {
  await runMigrations(db as Kysely<unknown>, 'group')
}
