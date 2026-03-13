import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Kysely } from 'kysely'
import { IdResolver } from '@atproto/identity'
import type { GlobalDatabase } from './db/schema.js'
import { runGlobalMigrations } from './db/migrate.js'
import { openSqliteDb } from './db/sqlite.js'
import { NonceCache } from './auth/nonce.js'
import { AuthVerifier } from './auth/verifier.js'
import { GroupDbPool } from './db/group-db-pool.js'
import { PdsAgentPool } from './pds/agent.js'
import type { Config } from './config.js'

export class AppContext {
  constructor(
    readonly cfg: Config,
    readonly globalDb: Kysely<GlobalDatabase>,
    readonly groupDbPool: GroupDbPool,
    readonly pdsAgentPool: PdsAgentPool,
    readonly authVerifier: AuthVerifier,
  ) {}

  static async create(cfg: Config): Promise<AppContext> {
    mkdirSync(cfg.dataDir, { recursive: true })

    const globalDb = openSqliteDb<GlobalDatabase>(join(cfg.dataDir, 'global.sqlite'))

    try {
      await runGlobalMigrations(globalDb)
    } catch (err) {
      await globalDb.destroy()
      throw err
    }

    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
    })

    const nonceCache = new NonceCache(globalDb)

    const authVerifier = new AuthVerifier(idResolver, nonceCache, globalDb)

    const encryptionKey = Buffer.from(cfg.encryptionKey, 'hex')
    const pdsAgentPool = new PdsAgentPool(globalDb, encryptionKey)

    const groupDbPool = new GroupDbPool(join(cfg.dataDir, 'groups'))

    return new AppContext(cfg, globalDb, groupDbPool, pdsAgentPool, authVerifier)
  }

  async destroy(): Promise<void> {
    await this.groupDbPool.destroyAll()
    await this.globalDb.destroy()
  }
}
