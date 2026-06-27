/**
 * The auth wrapper: the single place that mints atproto service-auth JWTs and
 * calls the CGS XRPC API. Consolidates the login + getServiceAuth + fetch logic
 * that the tests/smoke/* scripts each inline, so step definitions are one-liners
 * and there is one source of truth for minting.
 *
 * Minting a JWT via a password login (getServiceAuth over a password session) is
 * a SMOKE-TEST CONVENIENCE — real callers authenticate via OAuth and call
 * getServiceAuth over an OAuth session (see docs/integration-guide.md). The
 * accounts here are pre-provisioned test accounts with passwords.
 *
 * Auth facts baked in (verified against src/auth/verifier.ts):
 *  - service-level methods (group.import / group.register): aud = the SERVICE DID.
 *  - group-scoped methods (everything else) accept two forms (#27):
 *      - NEW: aud = the SERVICE DID, with the group named by an explicit `repo`
 *        (querystring for queries/uploadBlob/destroy, request body for the
 *        member/role procedures and createRecord/putRecord/deleteRecord).
 *      - LEGACY (deprecated): aud = the GROUP DID, no `repo`. Still works, but
 *        the response carries an RFC 8594 `Deprecation` header.
 *  - tokens are single-use (jti replay protection) and short-lived (exp - iat <=
 *    120s), so mint a FRESH token for every call — never reuse one.
 */
import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'
import { resolveToDid, resolveAccount } from '../../tests/smoke/lib.js'

/** One shared resolver per process — DID documents are cached internally. */
export const idResolver = new IdResolver()

export { resolveToDid, resolveAccount }

export interface MintOpts {
  identifier: string
  password: string
  aud: string
  lxm: string
}

/**
 * Mint a fresh service-auth JWT by logging into the caller's PDS and calling
 * getServiceAuth. The generic "sign as any caller" primitive: pass
 * owner/admin/member/outsider creds to act as that role.
 */
export async function mintServiceAuth(opts: MintOpts): Promise<string> {
  const account = await resolveAccount(idResolver, opts.identifier)
  const agent = new AtpAgent({ service: account.pds })
  await agent.login({ identifier: opts.identifier, password: opts.password })
  const { data } = await agent.com.atproto.server.getServiceAuth({
    aud: opts.aud,
    lxm: opts.lxm,
  })
  return data.token
}

/** Minimal slice of the World that callXrpc writes to. */
export interface HttpSink {
  lastHttpStatus?: number
  lastHttpJson?: Record<string, unknown>
  lastHttpBody?: string
  lastHttpHeaders?: Headers
}

export interface CallOpts {
  cgsUrl: string
  nsid: string
  token: string
  body?: unknown
  /** Defaults to POST; queries (member.list, audit.query, membership.list) use GET. */
  method?: 'GET' | 'POST'
  /**
   * Explicit group target for the #27 new path, sent as the `repo` querystring.
   * Use for query methods (and uploadBlob/destroy). Procedures that take a JSON
   * body name the group via `body.repo` instead.
   */
  repo?: string
}

/** Append a `repo` querystring param to an /xrpc/<nsid> URL if provided. */
function xrpcUrl(cgsUrl: string, nsid: string, repo?: string): string {
  const url = `${cgsUrl}/xrpc/${nsid}`
  return repo ? `${url}?repo=${encodeURIComponent(repo)}` : url
}

/**
 * Call an XRPC method with a Bearer token and record status/json/body/headers on
 * the sink. JSON Content-Type is set only when a JSON body is present.
 */
export async function callXrpc(sink: HttpSink, opts: CallOpts): Promise<void> {
  resetSink(sink)
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(xrpcUrl(opts.cgsUrl, opts.nsid, opts.repo), {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  await recordResponse(sink, res)
}

/**
 * Call an XRPC method with an API key in the `X-API-Key` header (no JWT). The
 * group is named by `repo` on the **querystring**: API-key auth resolves the
 * group before the JSON body is parsed, so (unlike a JWT procedure call) it
 * cannot read a body `repo`. All key-accessible ops in iteration 1 are queries,
 * so this is sufficient. The long-lived-credential path a backend uses (#26).
 */
export async function callXrpcWithApiKey(
  sink: HttpSink,
  opts: {
    cgsUrl: string
    nsid: string
    apiKey: string
    body?: unknown
    method?: 'GET' | 'POST'
    repo?: string
  },
): Promise<void> {
  resetSink(sink)
  const headers: Record<string, string> = { 'X-API-Key': opts.apiKey }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(xrpcUrl(opts.cgsUrl, opts.nsid, opts.repo), {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  await recordResponse(sink, res)
}

/**
 * Call an admin XRPC method with HTTP Basic auth (username `admin`, password the
 * service's CGS_ADMIN_PASSWORD) instead of a service-auth JWT. The admin
 * namespace (`app.certified.group.admin.*`) is operator-gated, not member-gated;
 * see src/auth/verifier.ts#verifyAdmin. Pass an empty/wrong password to exercise
 * the rejection paths.
 */
export async function callXrpcWithBasicAuth(
  sink: HttpSink,
  opts: {
    cgsUrl: string
    nsid: string
    password: string
    body?: unknown
    /** Username; defaults to `admin`. Override to test a wrong username. */
    username?: string
    /** Omit the Authorization header entirely (no-credentials case). */
    noAuth?: boolean
    method?: 'GET' | 'POST'
  },
): Promise<void> {
  resetSink(sink)
  const headers: Record<string, string> = {}
  if (!opts.noAuth) {
    const creds = Buffer.from(`${opts.username ?? 'admin'}:${opts.password}`).toString('base64')
    headers.Authorization = `Basic ${creds}`
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(xrpcUrl(opts.cgsUrl, opts.nsid), {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  await recordResponse(sink, res)
}

/**
 * Raw-stream upload for app.certified.group.repo.uploadBlob — the handler reads
 * the raw request body (not JSON), so the bytes go straight in the body with the
 * blob's own Content-Type.
 */
export async function uploadBlobXrpc(
  sink: HttpSink,
  opts: {
    cgsUrl: string
    token: string
    bytes: ArrayBuffer
    contentType: string
    /** Explicit group target for the #27 new path (querystring), since the body is the blob. */
    repo?: string
  },
): Promise<void> {
  resetSink(sink)
  // Wrap the raw bytes in a Blob so the body is a BodyInit the fetch typings
  // accept across lib configs (a bare Uint8Array is rejected by some). An
  // ArrayBuffer is an unambiguous BlobPart in every lib config.
  const res = await fetch(xrpcUrl(opts.cgsUrl, 'app.certified.group.repo.uploadBlob', opts.repo), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': opts.contentType,
    },
    body: new Blob([opts.bytes], { type: opts.contentType }),
  })

  await recordResponse(sink, res)
}

/**
 * Clear any previously-recorded response. Call this before each fetch() so that
 * if the request itself rejects (network error) — and recordResponse never runs
 * — the failure hook reports an empty state for this step rather than stale
 * details left over from the previous request.
 */
function resetSink(sink: HttpSink): void {
  sink.lastHttpStatus = undefined
  sink.lastHttpJson = undefined
  sink.lastHttpBody = undefined
  sink.lastHttpHeaders = undefined
}

async function recordResponse(sink: HttpSink, res: Response): Promise<void> {
  const text = await res.text()
  sink.lastHttpStatus = res.status
  sink.lastHttpBody = text
  sink.lastHttpHeaders = res.headers
  try {
    sink.lastHttpJson = JSON.parse(text) as Record<string, unknown>
  } catch {
    sink.lastHttpJson = undefined
  }
}
