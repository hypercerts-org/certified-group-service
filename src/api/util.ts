import type { Server, MethodHandler, RouteOptions } from '@atproto/xrpc-server'
import type { Response as ExpressResponse } from 'express'
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

/**
 * Resolve the target group for an authed request.
 *
 * Queries set `groupDid` on the credential at the verifier (from the `repo`
 * querystring or the legacy `aud` overload). Body-input methods leave it
 * undefined on the new path and pass the group as `repo` in the body, which the
 * verifier cannot read; this resolves that body `repo` (handle or DID) to a
 * registered group DID.
 *
 * Precedence mirrors the verifier: an explicit body `repo` wins (new path); if
 * absent, the credential's `aud`-derived `groupDid` is used (legacy path). One
 * of the two must be present.
 */
export async function resolveGroupDid(
  ctx: AppContext,
  credentials: { groupDid?: string },
  bodyRepo: string | undefined,
): Promise<string> {
  if (bodyRepo !== undefined && bodyRepo.length > 0) {
    return ctx.authVerifier.resolveRepoToGroup(bodyRepo)
  }
  if (credentials.groupDid) return credentials.groupDid
  throw new XRPCError(400, 'Missing repo', 'InvalidRequest')
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

/**
 * Link to the deprecation explanation, surfaced in the RFC 8594 `Link` header
 * on legacy-`aud` responses.
 */
const DEPRECATION_INFO_URL = 'https://github.com/hypercerts-org/certified-group-service/issues/27'

/** One warn per caller-DID per this window, to keep legacy traffic from flooding logs. */
const LEGACY_WARN_WINDOW_MS = 15 * 60 * 1000
/** Cap on distinct callers tracked; above this we sweep expired entries first. */
const LEGACY_WARN_MAX_ENTRIES = 10_000
const lastLegacyWarn = new Map<string, number>()

/**
 * Per-key rate limiter backed by a bounded `Map<key, lastSeenMs>`. Returns true
 * (and records `now`) when `key` has not been seen within `windowMs`; false
 * otherwise.
 *
 * Memory is hard-bounded to `maxEntries`. Before inserting a new key at the cap
 * it first sweeps entries older than the window (cheap, and they'd fire again
 * anyway); if every entry is still fresh (a high-cardinality burst), it evicts
 * the oldest by insertion order (`Map` preserves it) so the cap is never
 * exceeded. Evicting a fresh entry only costs that key one extra warn later.
 */
export function rateLimitAllow(
  map: Map<string, number>,
  key: string,
  now: number,
  windowMs: number,
  maxEntries: number,
): boolean {
  const previous = map.get(key)
  if (previous !== undefined && now - previous < windowMs) return false
  if (map.size >= maxEntries && !map.has(key)) {
    for (const [k, ts] of map) {
      if (now - ts >= windowMs) map.delete(k)
    }
    // Still full of fresh entries: evict the oldest to keep a hard cap.
    if (map.size >= maxEntries) {
      const oldest: string | undefined = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }
  map.set(key, now)
  return true
}

/**
 * Signal the deprecated `aud`-as-group path (issue #27) on a per-request basis:
 * attach RFC 8594 headers so clients can detect it programmatically, and emit a
 * rate-limited warn so operators can see lingering legacy traffic. No `Sunset`
 * header — a removal date is not yet set.
 */
function signalLegacyAud(ctx: AppContext, res: ExpressResponse, callerDid: string, nsid: string) {
  res.setHeader('Deprecation', 'true')
  res.setHeader('Link', `<${DEPRECATION_INFO_URL}>; rel="deprecation"`)

  if (
    rateLimitAllow(
      lastLegacyWarn,
      callerDid,
      Date.now(),
      LEGACY_WARN_WINDOW_MS,
      LEGACY_WARN_MAX_ENTRIES,
    )
  ) {
    ctx.logger.warn(
      { callerDid, nsid },
      'Deprecated auth: group taken from JWT aud. Pass an explicit `repo` and set aud to the service DID (issue #27).',
    )
  }
}

export function registerAuthedMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: AuthedMethodConfig,
): void {
  const handler: MethodHandler<GroupAuthResult> = async (reqCtx) => {
    if (reqCtx.auth.credentials.legacyAud) {
      signalLegacyAud(ctx, reqCtx.res, reqCtx.auth.credentials.callerDid, nsid)
    }
    return config.handler(reqCtx)
  }
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcAuth(),
    opts: config.opts,
    handler,
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
