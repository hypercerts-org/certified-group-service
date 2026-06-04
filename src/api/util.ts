import type { Server, MethodHandler, RouteOptions } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { AppContext } from '../context.js'
import type { GroupAuthResult, ServiceAuthResult } from '../auth/verifier.js'
import type { AuditEventDetail } from '../audit.js'
import type { Operation } from '../rbac/permissions.js'
import type { GroupDatabase } from '../db/schema.js'
import { XRPCError as ClientXRPCError } from '@atproto/xrpc'
import { XRPCError, UpstreamFailureError } from '@atproto/xrpc-server'
import type { PdsAgentPool } from '../pds/agent.js'

export interface AuthedMethodConfig {
  opts?: RouteOptions
  handler: MethodHandler<GroupAuthResult>
}

export interface ServiceAuthMethodConfig {
  opts?: RouteOptions
  handler: MethodHandler<ServiceAuthResult>
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
 * Proxy a call to the group's PDS.
 *
 * 4xx errors from the PDS are forwarded to the client so they can
 * distinguish e.g. "duplicate rkey" (400) from a server problem.
 * 401s are already handled by PdsAgentPool.withAgent (auto-retry),
 * so any 401 that reaches here is a genuine auth failure on our side
 * and gets wrapped as 502 along with 5xx and network errors.
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
    if (err instanceof ClientXRPCError) {
      // err.status is the ResponseType enum; coerce to its numeric HTTP
      // status code so we can range-check it.
      const status = Number(err.status)
      if (status >= 400 && status < 500 && status !== 401) {
        throw new XRPCError(status, err.message, err.error)
      }
    }
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

/**
 * Register a group-bootstrapping XRPC method (register, import) — one whose
 * audience is the service's own DID rather than a group DID, and whose target
 * group does not yet exist in the service. Unlike registerAuthedMethod, the
 * auth verifier does not open a per-group DB or check group membership; it only
 * proves the caller controls the issuing DID. The handler is responsible for
 * any ownerDid / authorship checks.
 */
export function registerServiceAuthMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: ServiceAuthMethodConfig,
): void {
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcServiceAuth(),
    opts: config.opts,
    handler: config.handler,
  })
}
