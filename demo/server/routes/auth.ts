import * as crypto from 'node:crypto'
import { Router } from 'express'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateDpopKeyPair,
  createDpopProof,
  restoreDpopKeyPair,
} from '../oauth/crypto.js'

const router = Router()

const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || ''
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || ''

/** Cached AS metadata endpoints */
let asMetadata: { par: string; authorize: string; token: string } | null = null

/** Fetch OAuth Authorization Server metadata to discover endpoints */
async function getAsMetadata() {
  if (asMetadata) return asMetadata
  const res = await fetch(`${EPDS_URL}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw new Error(`Failed to fetch AS metadata: ${res.status}`)
  const data = (await res.json()) as Record<string, string>
  asMetadata = {
    par: data.pushed_authorization_request_endpoint,
    authorize: data.authorization_endpoint,
    token: data.token_endpoint,
  }
  return asMetadata
}

/**
 * POST /api/login — initiate OAuth flow (Flow 2: ePDS handles email form)
 * Returns { redirectUrl } for the frontend to redirect the browser.
 */
router.post('/login', async (req, res) => {
  try {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).json({ error: 'OAUTH_CLIENT_ID and OAUTH_REDIRECT_URI must be configured' })
    }

    const endpoints = await getAsMetadata()
    const parEndpoint = endpoints.par
    const authEndpoint = endpoints.authorize

    // Generate PKCE + DPoP + state
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = crypto.randomBytes(16).toString('base64url')
    const { privateKey, publicJwk, privateJwk } = generateDpopKeyPair()

    // Build PAR request body
    const parBody = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'atproto transition:generic',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    // First PAR attempt (will get a 400 with dpop-nonce)
    let dpopProof = createDpopProof({
      privateKey,
      jwk: publicJwk,
      method: 'POST',
      url: parEndpoint,
    })

    let parRes = await fetch(parEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: parBody.toString(),
    })

    // Retry with nonce if challenged
    if (!parRes.ok) {
      const dpopNonce = parRes.headers.get('dpop-nonce')
      if (dpopNonce && parRes.status === 400) {
        dpopProof = createDpopProof({
          privateKey,
          jwk: publicJwk,
          method: 'POST',
          url: parEndpoint,
          nonce: dpopNonce,
        })
        parRes = await fetch(parEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: parBody.toString(),
        })
      }
    }

    if (!parRes.ok) {
      const errBody = await parRes.text().catch(() => '')
      console.error('PAR failed:', parRes.status, errBody)
      return res.status(502).json({ error: `PAR request failed (${parRes.status})` })
    }

    const { request_uri } = (await parRes.json()) as { request_uri: string }

    // Store OAuth flow state in session
    req.session.oauthFlow = {
      codeVerifier,
      state,
      dpopPrivateJwk: privateJwk,
    }

    // Build redirect URL (Flow 2 — no login_hint)
    const redirectUrl = `${authEndpoint}?client_id=${encodeURIComponent(CLIENT_ID)}&request_uri=${encodeURIComponent(request_uri)}`

    // Explicitly save session before responding
    req.session.save((err) => {
      if (err) {
        console.error('Session save failed:', err)
        return res.status(500).json({ error: 'Failed to save session' })
      }
      res.json({ redirectUrl })
    })
  } catch (err: any) {
    console.error('Login initiation failed:', err.message)
    res.status(500).json({ error: err.message || 'Failed to initiate login' })
  }
})

/**
 * GET /api/oauth/callback — handle redirect from ePDS after OTP verification.
 * Exchanges code for access token, resolves handle, creates session.
 */
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string }
    const oauthFlow = req.session.oauthFlow

    if (!code || !state) {
      return res.redirect('/?error=missing_code_or_state')
    }

    if (!oauthFlow) {
      return res.redirect('/?error=no_oauth_session')
    }

    if (state !== oauthFlow.state) {
      return res.redirect('/?error=state_mismatch')
    }

    const endpoints = await getAsMetadata()
    const tokenEndpoint = endpoints.token
    const { privateKey, publicJwk } = restoreDpopKeyPair(oauthFlow.dpopPrivateJwk)

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: oauthFlow.codeVerifier,
    })

    // First token attempt
    let dpopProof = createDpopProof({
      privateKey,
      jwk: publicJwk,
      method: 'POST',
      url: tokenEndpoint,
    })

    let tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof,
      },
      body: tokenBody.toString(),
    })

    // Retry with nonce if challenged
    if (!tokenRes.ok) {
      const dpopNonce = tokenRes.headers.get('dpop-nonce')
      if (dpopNonce) {
        dpopProof = createDpopProof({
          privateKey,
          jwk: publicJwk,
          method: 'POST',
          url: tokenEndpoint,
          nonce: dpopNonce,
        })
        tokenRes = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            DPoP: dpopProof,
          },
          body: tokenBody.toString(),
        })
      }
    }

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '')
      console.error('Token exchange failed:', tokenRes.status, errBody)
      return res.redirect('/?error=token_exchange_failed')
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      sub: string
    }

    // Resolve DID to handle via PLC directory
    let handle = tokenData.sub
    try {
      const plcRes = await fetch(`https://plc.directory/${tokenData.sub}`)
      if (plcRes.ok) {
        const plcData = (await plcRes.json()) as { alsoKnownAs?: string[] }
        const atUri = plcData.alsoKnownAs?.find((u: string) => u.startsWith('at://'))
        if (atUri) {
          handle = atUri.replace('at://', '')
        }
      }
    } catch {
      // Fall back to DID as handle
    }

    // Store session
    req.session.user = {
      did: tokenData.sub,
      handle,
      pdsUrl: EPDS_URL,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      dpopPrivateJwk: oauthFlow.dpopPrivateJwk,
    }

    // Clean up OAuth flow state
    delete req.session.oauthFlow

    console.log('OAuth login successful:', { did: tokenData.sub, handle })

    // Explicitly save session before redirecting
    req.session.save((err) => {
      if (err) {
        console.error('Session save failed:', err)
        return res.redirect('/?error=session_save_failed')
      }
      res.redirect('/')
    })
  } catch (err: any) {
    console.error('OAuth callback failed:', err.message)
    res.redirect('/?error=callback_failed')
  }
})

/** POST /api/logout — destroy session */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true })
  })
})

/** GET /api/me — return current user from session */
router.get('/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  res.json({ did: req.session.user.did, handle: req.session.user.handle })
})

export default router
