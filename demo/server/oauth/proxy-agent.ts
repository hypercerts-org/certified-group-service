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

export interface GroupServiceResult {
  status: number
  data: any
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
 */
export async function callGroupService(
  userDid: string,
  groupDid: string,
  nsid: string,
  opts: { method: 'GET' | 'POST'; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<GroupServiceResult> {
  const oauthSession = await getOauthClient().restore(userDid)
  const agent = new Agent(oauthSession)

  // Prove the caller controls userDid; aud = service DID, lxm = the method.
  const serviceAuth = await agent.com.atproto.server.getServiceAuth({
    aud: GROUP_SERVICE_DID,
    lxm: nsid,
  })

  // The group is always identified by `repo`: querystring for queries, body for
  // procedures (matches the group service's verifier, which reads repo before
  // the body is parsed for queries).
  const query = new URLSearchParams({ repo: groupDid, ...(opts.params ?? {}) }).toString()
  const url = `${GROUP_SERVICE_URL.replace(/\/$/, '')}/xrpc/${nsid}?${query}`

  const headers: Record<string, string> = { Authorization: `Bearer ${serviceAuth.data.token}` }
  let requestBody: string | undefined
  if (opts.method === 'POST') {
    headers['Content-Type'] = 'application/json'
    // Include repo in the body too so procedure handlers that read input.body.repo
    // resolve the same group (the confused-deputy guard requires body == querystring).
    requestBody = JSON.stringify({ repo: groupDid, ...(opts.body ?? {}) })
  }

  const upstream = await fetch(url, { method: opts.method, headers, body: requestBody })
  const data = await upstream.json().catch(() => ({}))
  return { status: upstream.status, data }
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
  const oauthSession = await getOauthClient().restore(userDid)
  const agent = new Agent(oauthSession)
  const nsid = 'app.certified.group.repo.uploadBlob'
  const serviceAuth = await agent.com.atproto.server.getServiceAuth({
    aud: GROUP_SERVICE_DID,
    lxm: nsid,
  })
  const url = `${GROUP_SERVICE_URL.replace(/\/$/, '')}/xrpc/${nsid}?repo=${encodeURIComponent(groupDid)}`
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceAuth.data.token}`,
      'Content-Type': mimetype,
    },
    body: bytes as unknown as BodyInit,
  })
  const data = await upstream.json().catch(() => ({}))
  return { status: upstream.status, data }
}
