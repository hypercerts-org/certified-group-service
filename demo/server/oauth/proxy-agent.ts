import { Agent } from '@atproto/api'
import { getOauthClient } from './client.js'

export function isSessionExpiredError(err: any): boolean {
  // Only treat OAuth-layer failures as session-expired.
  // Upstream XRPC 401s (e.g. "not a member") are authorization errors, not session errors.
  if (err.message?.includes('log in again')) return true
  // OAuthSessionError or token-refresh failures set status 401 but lack XRPC `error` field
  if (err.status === 401 && !err.error) return true
  return false
}

const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'
const GROUP_SERVICE_DID = process.env.GROUP_SERVICE_DID || ''
const UPSTREAM_TIMEOUT_MS = 15_000

export interface GroupServiceResult {
  status: number
  data: any
}

/**
 * fetch() bounded by a timeout so a slow/wedged group service can't hold a
 * request handler open indefinitely. A timeout surfaces as a 504; other
 * transport failures as 502.
 */
async function fetchUpstream(url: string, init: RequestInit): Promise<GroupServiceResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const upstream = await fetch(url, { ...init, signal: controller.signal })
    const data = await upstream.json().catch(() => ({}))
    return { status: upstream.status, data }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { status: 504, data: { error: 'group service did not respond in time' } }
    }
    return { status: 502, data: { error: err?.message || 'group service request failed' } }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The service DID is the JWT audience for every direct group-service call. Fail
 * fast with a clear message if it is unset, rather than letting getServiceAuth
 * reject with an opaque "empty aud" error deep in the call.
 */
function requireServiceDid(): string {
  if (!GROUP_SERVICE_DID) {
    throw new Error('GROUP_SERVICE_DID is not configured (see demo/README.md)')
  }
  return GROUP_SERVICE_DID
}

/**
 * Call a group-service XRPC method directly, authenticated with a service-auth
 * JWT minted by the user's PDS (aud = the group service DID, lxm = the method).
 *
 * This is preferred over the atproto service-proxy path (`createProxyAgent` +
 * withProxy): proxying makes the user's PDS resolve the GROUP DID's
 * `#certified_group` service, which fails ("could not resolve proxy did service
 * url") whenever the PDS's cached DID document predates the group's
 * service-entry PLC op. A direct call resolves the group from the `repo`
 * param (querystring for queries, body for procedures) and never touches PDS
 * DID-document caching.
 *
 * `groupDid` is optional: service-level methods (e.g. groups.membership.list,
 * which lists the caller's own groups) name no target group. When it is
 * undefined, no `repo` is sent — the service resolves the caller from the JWT
 * `iss` alone. When present, `repo` is forced LAST so caller-supplied
 * params/body can never override the routing target.
 */
export async function callGroupService(
  userDid: string,
  groupDid: string | undefined,
  nsid: string,
  opts: { method: 'GET' | 'POST'; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<GroupServiceResult> {
  const aud = requireServiceDid()
  const oauthSession = await getOauthClient().restore(userDid)
  const agent = new Agent(oauthSession)

  // Prove the caller controls userDid; aud = service DID, lxm = the method.
  const serviceAuth = await agent.com.atproto.server.getServiceAuth({ aud, lxm: nsid })

  // The group is identified by `repo`: querystring for queries, body for
  // procedures (matches the group service's verifier, which reads repo before
  // the body is parsed for queries). Omitted for service-level methods.
  const params = new URLSearchParams(opts.params ?? {})
  if (groupDid) params.set('repo', groupDid) // forced last — wins over caller params
  const query = params.toString()
  const url = `${GROUP_SERVICE_URL.replace(/\/$/, '')}/xrpc/${nsid}${query ? `?${query}` : ''}`

  const headers: Record<string, string> = { Authorization: `Bearer ${serviceAuth.data.token}` }
  let requestBody: string | undefined
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // Include repo in the body too so procedure handlers that read input.body.repo
    // resolve the same group (the confused-deputy guard requires body == querystring).
    // repo is forced last so a caller-supplied repo cannot override groupDid.
    requestBody = JSON.stringify(groupDid ? { ...(opts.body ?? {}), repo: groupDid } : (opts.body ?? {}))
  }

  return fetchUpstream(url, { method: opts.method, headers, body: requestBody })
}

/**
 * Upload a blob to the group service directly (service-auth JWT, raw bytes).
 * Same rationale as callGroupService — avoids the PDS service-proxy DID
 * resolution. uploadBlob takes the raw body with the file's content-type.
 */
export async function uploadGroupBlob(
  userDid: string,
  groupDid: string,
  bytes: Uint8Array,
  mimetype: string,
): Promise<GroupServiceResult> {
  const aud = requireServiceDid()
  const oauthSession = await getOauthClient().restore(userDid)
  const agent = new Agent(oauthSession)
  const nsid = 'app.certified.group.repo.uploadBlob'
  const serviceAuth = await agent.com.atproto.server.getServiceAuth({ aud, lxm: nsid })
  const url = `${GROUP_SERVICE_URL.replace(/\/$/, '')}/xrpc/${nsid}?repo=${encodeURIComponent(groupDid)}`
  return fetchUpstream(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceAuth.data.token}`,
      'Content-Type': mimetype,
    },
    body: bytes as unknown as BodyInit,
  })
}
