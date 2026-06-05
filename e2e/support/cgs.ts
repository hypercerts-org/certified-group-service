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
 *  - group-scoped methods (everything else): aud = the GROUP DID (which must
 *    already be imported, or the verifier rejects with Invalid audience).
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
}

export interface CallOpts {
  cgsUrl: string
  nsid: string
  token: string
  body?: unknown
  /** Defaults to POST; queries (member.list, audit.query, membership.list) use GET. */
  method?: 'GET' | 'POST'
}

/**
 * Call an XRPC method with a Bearer token and record status/json/body on the
 * sink. JSON Content-Type is set only when a JSON body is present.
 */
export async function callXrpc(sink: HttpSink, opts: CallOpts): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${opts.cgsUrl}/xrpc/${opts.nsid}`, {
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
  opts: { cgsUrl: string; token: string; bytes: ArrayBuffer; contentType: string },
): Promise<void> {
  // Wrap the raw bytes in a Blob so the body is a BodyInit the fetch typings
  // accept across lib configs (a bare Uint8Array is rejected by some). An
  // ArrayBuffer is an unambiguous BlobPart in every lib config.
  const res = await fetch(`${opts.cgsUrl}/xrpc/app.certified.group.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': opts.contentType,
    },
    body: new Blob([opts.bytes], { type: opts.contentType }),
  })

  await recordResponse(sink, res)
}

async function recordResponse(sink: HttpSink, res: Response): Promise<void> {
  const text = await res.text()
  sink.lastHttpStatus = res.status
  sink.lastHttpBody = text
  try {
    sink.lastHttpJson = JSON.parse(text) as Record<string, unknown>
  } catch {
    sink.lastHttpJson = undefined
  }
}
