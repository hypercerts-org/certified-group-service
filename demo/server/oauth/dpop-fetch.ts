import type { Request } from 'express'
import { createDpopProof, restoreDpopKeyPair } from './crypto.js'
import { getAsMetadata } from './metadata.js'
import type { SessionData } from '../session.js'

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || ''

/**
 * Refresh the OAuth access token using the stored refresh token.
 * Updates the session in-place and saves it.
 */
export async function refreshAccessToken(req: Request): Promise<void> {
  const session = req.session.user
  if (!session?.refreshToken) {
    throw new Error('No refresh token available — please log in again')
  }

  const { token: tokenEndpoint } = await getAsMetadata()

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
 * Returns a fetch function that attaches DPoP proofs and Authorization headers.
 * Handles dpop-nonce challenges and token refresh on 401.
 */
export function createDpopFetch(session: SessionData, req?: Request): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let { privateKey, publicJwk } = restoreDpopKeyPair(session.dpopPrivateJwk)

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()

    let proof = createDpopProof({
      privateKey,
      jwk: publicJwk,
      method,
      url,
      accessToken: session.accessToken,
    })

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `DPoP ${session.accessToken}`)
    headers.set('DPoP', proof)

    let res = await globalThis.fetch(input, { ...init, headers })

    // Retry with dpop-nonce if challenged
    if ((res.status === 400 || res.status === 401) && res.headers.get('dpop-nonce')) {
      const dpopNonce = res.headers.get('dpop-nonce')!
      proof = createDpopProof({
        privateKey,
        jwk: publicJwk,
        method,
        url,
        nonce: dpopNonce,
        accessToken: session.accessToken,
      })
      headers.set('DPoP', proof)
      res = await globalThis.fetch(input, { ...init, headers })
    }

    // On 401, try refreshing the access token and retry once
    if (res.status === 401 && req?.session.user?.refreshToken) {
      await refreshAccessToken(req)
      const refreshed = req.session.user!
      ;({ privateKey, publicJwk } = restoreDpopKeyPair(refreshed.dpopPrivateJwk))
      proof = createDpopProof({
        privateKey,
        jwk: publicJwk,
        method,
        url,
        accessToken: refreshed.accessToken,
      })
      headers.set('Authorization', `DPoP ${refreshed.accessToken}`)
      headers.set('DPoP', proof)
      res = await globalThis.fetch(input, { ...init, headers })
    }

    return res
  }
}
