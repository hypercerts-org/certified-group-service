import { Router } from 'express'
import { AtpAgent } from '@atproto/api'
import { createDpopFetch } from '../oauth/dpop-fetch.js'

const router = Router()
const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'

/**
 * POST /api/register — register a new group
 * Requires authentication. Owner DID is taken from the session.
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

    // Fetch the user's email from their ePDS session
    let email: string | undefined
    try {
      const agent = new AtpAgent({
        service: req.session.user.pdsUrl,
        fetch: createDpopFetch(req.session.user, req),
      })
      const sessionRes = await agent.com.atproto.server.getSession()
      email = sessionRes.data.email
    } catch (err: any) {
      console.warn('Could not fetch email from ePDS:', err.message)
    }

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/app.certified.group.register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
