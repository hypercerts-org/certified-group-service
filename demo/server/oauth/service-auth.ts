/**
 * Fetches a service auth JWT from the user's PDS via getServiceAuth.
 * The returned JWT authorizes a single call to the group service for
 * the specified lexicon method.
 */
import type { Request } from 'express'
import { createDpopFetch } from './dpop-fetch.js'
import type { SessionData } from '../session.js'

export class ServiceAuthError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ServiceAuthError'
  }
}

/**
 * Fetch a service auth JWT for calling `lxm` on the group service at `aud`.
 * Uses createDpopFetch for DPoP proof creation, nonce handling, and token refresh.
 */
export async function fetchServiceAuth(
  session: SessionData,
  aud: string,
  lxm: string,
  req?: Request,
): Promise<string> {
  const dpopFetch = createDpopFetch(session, req)
  const url = `${session.pdsUrl}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}`

  const res = await dpopFetch(url)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ServiceAuthError(`getServiceAuth failed (${res.status}): ${body}`, res.status)
  }

  const data = (await res.json()) as { token: string }
  return data.token
}
