import type { Request } from 'express'
import { createDpopProof, restoreDpopKeyPair } from './crypto.js'
import type { SessionData } from '../session.js'

const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || ''

/**
 * Refresh the OAuth access token using the stored refresh token.
 * Updates the session in-place and saves it.
 */
async function refreshAccessToken(req: Request): Promise<void> {
  const session = req.session.user
  if (!session?.refreshToken) {
    throw new Error('No refresh token available — please log in again')
  }

  // Discover token endpoint
  const asRes = await fetch(`${EPDS_URL}/.well-known/oauth-authorization-server`)
  if (!asRes.ok) throw new Error(`Failed to fetch AS metadata: ${asRes.status}`)
  const asMeta = (await asRes.json()) as Record<string, string>
  const tokenEndpoint = asMeta.token_endpoint

  const { privateKey, publicJwk } = restoreDpopKeyPair(session.dpopPrivateJwk)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: CLIENT_ID,
  })

  // First attempt (may get dpop-nonce challenge)
  let dpopProof = createDpopProof({
    privateKey,
    jwk: publicJwk,
    method: 'POST',
    url: tokenEndpoint,
  })

  let res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof,
    },
    body: body.toString(),
  })

  // Retry with DPoP nonce if challenged
  if (!res.ok) {
    const dpopNonce = res.headers.get('dpop-nonce')
    if (dpopNonce) {
      dpopProof = createDpopProof({
        privateKey,
        jwk: publicJwk,
        method: 'POST',
        url: tokenEndpoint,
        nonce: dpopNonce,
      })
      res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: dpopProof,
        },
        body: body.toString(),
      })
    }
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Token refresh failed (${res.status}): ${errBody}`)
  }

  const tokenData = (await res.json()) as {
    access_token: string
    refresh_token?: string
  }

  // Update session with new tokens
  session.accessToken = tokenData.access_token
  if (tokenData.refresh_token) {
    session.refreshToken = tokenData.refresh_token
  }

  // Persist updated session
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Make a DPoP-bound getServiceAuth request with the given access token.
 */
async function fetchServiceAuth(
  session: SessionData,
  aud: string,
  lxm: string,
): Promise<Response> {
  const { privateKey, publicJwk } = restoreDpopKeyPair(session.dpopPrivateJwk)
  const url = `${session.pdsUrl}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}`

  let dpopProof = createDpopProof({
    privateKey,
    jwk: publicJwk,
    method: 'GET',
    url,
    accessToken: session.accessToken,
  })

  let res = await fetch(url, {
    headers: {
      Authorization: `DPoP ${session.accessToken}`,
      DPoP: dpopProof,
    },
  })

  // Retry with DPoP nonce if challenged
  if (!res.ok) {
    const dpopNonce = res.headers.get('dpop-nonce')
    if (dpopNonce) {
      dpopProof = createDpopProof({
        privateKey,
        jwk: publicJwk,
        method: 'GET',
        url,
        nonce: dpopNonce,
        accessToken: session.accessToken,
      })
      res = await fetch(url, {
        headers: {
          Authorization: `DPoP ${session.accessToken}`,
          DPoP: dpopProof,
        },
      })
    }
  }

  return res
}

/**
 * Call com.atproto.server.getServiceAuth on the ePDS using DPoP-bound access token.
 * Automatically refreshes the access token on 401 if a refresh token is available.
 * Returns a service auth JWT scoped to the given audience and lexicon method.
 */
export async function getServiceAuth(
  session: SessionData,
  aud: string,
  lxm: string,
  req?: Request,
): Promise<string> {
  let res = await fetchServiceAuth(session, aud, lxm)

  // On 401, try refreshing the access token and retry once
  if (res.status === 401 && req?.session.user?.refreshToken) {
    await refreshAccessToken(req)
    res = await fetchServiceAuth(req.session.user!, aud, lxm)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`getServiceAuth failed (${res.status}): ${body}`)
  }

  const { token } = (await res.json()) as { token: string }
  return token
}
