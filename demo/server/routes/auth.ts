import { Router } from 'express'
import { Agent } from '@atproto/api'
import { oauthClient } from '../oauth/client.js'

const router = Router()

const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'

/**
 * POST /api/login — initiate OAuth flow
 * Body: { handle } (optional — defaults to ePDS URL for email-based login)
 * Returns { redirectUrl } for the frontend to redirect the browser.
 */
router.post('/login', async (req, res) => {
  try {
    // Accept a handle/DID, or fall back to the ePDS URL for email-based auth
    const input = req.body.handle || EPDS_URL
    const url = await oauthClient.authorize(input, {
      scope: 'atproto transition:generic',
    })
    res.json({ redirectUrl: url.toString() })
  } catch (err: any) {
    console.error('Login initiation failed:', err.message)
    res.status(500).json({ error: err.message || 'Failed to initiate login' })
  }
})

/**
 * GET /api/oauth/callback — handle redirect from authorization server.
 * Exchanges code for session, stores DID in express-session.
 */
router.get('/oauth/callback', async (req, res) => {
  try {
    const params = new URLSearchParams(req.url.split('?')[1])
    const { session: oauthSession } = await oauthClient.callback(params)

    // Resolve handle
    let handle: string = oauthSession.did
    try {
      const agent = new Agent(oauthSession)
      const profile = await agent.com.atproto.server.getSession()
      handle = profile.data.handle
    } catch {
      // Fall back to DID
    }

    req.session.user = {
      did: oauthSession.did,
      handle,
    }

    req.session.save((err) => {
      if (err) {
        console.error('Session save failed:', err)
        return res.redirect('/?error=session_save_failed')
      }
      console.log('OAuth login successful:', { did: oauthSession.did, handle })
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
