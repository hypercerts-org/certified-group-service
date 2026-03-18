import { Router } from 'express'
import { createDpopFetch } from '../oauth/dpop-fetch.js'
import { GROUP_SERVICE_URL } from '../oauth/group-client.js'
import { fetchServiceAuth } from '../oauth/service-auth.js'

const router = Router()

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

    // Fetch the user's email from their ePDS session (optional)
    let email: string | undefined
    try {
      const dpopFetch = createDpopFetch(req.session.user, req)
      const sessionRes = await dpopFetch(
        `${req.session.user.pdsUrl}/xrpc/com.atproto.server.getSession`,
      )
      if (sessionRes.ok) {
        const data = (await sessionRes.json()) as { email?: string }
        email = data.email
      }
    } catch (err: any) {
      console.warn('Could not fetch email from ePDS:', err.message)
    }

    // Get a service auth JWT from the user's PDS to prove they control ownerDid
    const token = await fetchServiceAuth(
      req.session.user,
      GROUP_SERVICE_DID,
      'app.certified.group.register',
      req,
    )

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/app.certified.group.register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
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
