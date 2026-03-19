import { Router } from 'express'
import { Agent } from '@atproto/api'
import { oauthClient } from '../oauth/client.js'

const router = Router()
const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'
const GROUP_SERVICE_DID = process.env.GROUP_SERVICE_DID || ''

/**
 * POST /api/register — register a new group
 * Requires authentication. Owner DID is taken from the session.
 * Gets a service auth JWT from the user's PDS to prove DID control.
 * Body: { handle }
 */
router.post('/', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated — log in first' })
    }

    const { handle } = req.body
    if (!handle) {
      return res.status(400).json({ error: 'Missing required field: handle' })
    }

    const ownerDid = req.session.user.did

    // Restore the OAuth session to get an authenticated agent
    const oauthSession = await oauthClient.restore(ownerDid)
    const agent = new Agent(oauthSession)

    // Fetch the user's email from their PDS session (optional)
    let email: string | undefined
    try {
      const sessionRes = await agent.com.atproto.server.getSession()
      email = sessionRes.data.email
    } catch (err: any) {
      console.warn('Could not fetch email from PDS:', err.message)
    }

    // Get a service auth JWT from the user's PDS to prove they control ownerDid
    const serviceAuth = await agent.com.atproto.server.getServiceAuth({
      aud: GROUP_SERVICE_DID,
      lxm: 'app.certified.group.register',
    })

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/app.certified.group.register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceAuth.data.token}`,
      },
      body: JSON.stringify({ handle, ownerDid, email }),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json(data)
    }

    res.json(data)
  } catch (err: any) {
    console.error('Register error:', err.message)
    res.status(500).json({ error: err.message || 'Registration failed' })
  }
})

export default router
