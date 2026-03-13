import type { Kysely } from 'kysely'
import type { GroupDatabase } from './db/schema.js'

export type AuditResult = 'permitted' | 'denied'

export type AuditEventDetail = {
  collection?: string
  rkey?: string
  reason?: string
  [key: string]: unknown
}

export interface AuditLogger {
  logAuditEvent(
    groupDb: Kysely<GroupDatabase>,
    actorDid: string,
    action: string,
    result: AuditResult,
    detail?: AuditEventDetail,
    jti?: string,
  ): Promise<void>
}

export async function logAuditEvent(
  groupDb: Kysely<GroupDatabase>,
  actorDid: string,
  action: string,
  result: AuditResult,
  detail?: AuditEventDetail,
  jti?: string,
): Promise<void> {
  await groupDb.insertInto('group_audit_log').values({
    actor_did: actorDid,
    action,
    collection: detail?.collection ?? null,
    rkey: detail?.rkey ?? null,
    result,
    detail: detail ? JSON.stringify(detail) : null,
    jti: jti ?? null,
  }).execute()
}
