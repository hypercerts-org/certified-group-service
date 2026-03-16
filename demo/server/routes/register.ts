import { Router } from 'express'

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

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/app.certified.group.register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, ownerDid }),
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
