import type { Server, MethodHandler, RouteOptions } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { AppContext } from '../context.js'
import type { GroupAuthResult } from '../auth/verifier.js'
import type { AuditEventDetail } from '../audit.js'
import type { Operation } from '../rbac/permissions.js'
import type { GroupDatabase } from '../db/schema.js'
import { UpstreamFailureError } from '../errors.js'
import type { PdsAgentPool } from '../pds/agent.js'

export interface AuthedMethodConfig {
  opts?: RouteOptions
  handler: MethodHandler<GroupAuthResult>
}

export function jsonResponse<T>(body: T) {
  return { encoding: 'application/json' as const, body }
}

/** Convert a SQLite DATETIME string (no timezone) to ISO 8601. */
export function sqliteToIso(timestamp: string): string {
  return new Date(timestamp + 'Z').toISOString()
}

export function encodeCursor(payload: string): string {
  return Buffer.from(payload).toString('base64')
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf8')
}

export async function assertCanWithAudit(
  ctx: AppContext,
  groupDb: Kysely<GroupDatabase>,
  callerDid: string,
  operation: Operation,
  detail?: Omit<AuditEventDetail, 'reason'>,
): Promise<void> {
  try {
    await ctx.rbac.assertCan(groupDb, callerDid, operation)
  } catch (err) {
    await ctx.audit.log(groupDb, callerDid, operation, 'denied', {
      ...detail,
      reason: (err as Error).message,
    })
    throw err
  }
}

/**
 * Proxy a call to the group's PDS, wrapping any PDS/network errors as 502.
 * Without this, PDS errors leak through with their original status codes
 * (e.g. a PDS 401 becomes a CGS 401, confusing the caller).
 */
export async function proxyToPds<T>(
  pdsAgents: PdsAgentPool,
  groupDid: string,
  fn: (agent: import('@atproto/api').Agent) => Promise<T>,
): Promise<T> {
  try {
    return await pdsAgents.withAgent(groupDid, fn)
  } catch (err) {
    if (err instanceof UpstreamFailureError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new UpstreamFailureError(`Upstream PDS error: ${msg}`)
  }
}

export function registerAuthedMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: AuthedMethodConfig,
): void {
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcAuth(),
    opts: config.opts,
    handler: config.handler,
  })
}
