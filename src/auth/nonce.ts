import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { GlobalDatabase } from '../db/schema.js'

export const NONCE_TTL_SECONDS = 120
const NONCE_EXPIRES_AT = sql<string>`datetime('now', '+${sql.raw(String(NONCE_TTL_SECONDS))} seconds')`

export class NonceCache {
  constructor(private db: Kysely<GlobalDatabase>) {}

  async checkAndStore(jti: string): Promise<boolean> {
    const result = await this.db
      .insertInto('nonce_cache')
      .values({
        jti,
        expires_at: NONCE_EXPIRES_AT,
      })
      .onConflict((oc) => oc.column('jti').doNothing())
      .returning('jti')
      .executeTakeFirst()
    return result !== undefined
  }

  async cleanup(): Promise<void> {
    await this.db.deleteFrom('nonce_cache').where('expires_at', '<', sql<string>`datetime('now')`).execute()
  }
}
