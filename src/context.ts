import type { Kysely } from 'kysely'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import type { GlobalDatabase } from './db/schema.js'
import type { GroupDbPool } from './db/group-db-pool.js'
import type { AuthVerifier } from './auth/verifier.js'
import type { RbacChecker } from './rbac/check.js'
import type { PdsAgentPool } from './pds/agent.js'
import type { AuditLogger } from './audit.js'
import type { MemberIndexWriter } from './db/member-index.js'

export interface AppContext {
  config: Config
  globalDb: Kysely<GlobalDatabase>
  globalDbPath: string
  groupDbs: GroupDbPool
  authVerifier: AuthVerifier
  rbac: RbacChecker
  pdsAgents: PdsAgentPool
  audit: AuditLogger
  memberIndex: MemberIndexWriter
  logger: Logger
}
