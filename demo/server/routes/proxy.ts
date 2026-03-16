import { Router } from 'express'
import { getServiceAuth } from '../oauth/service-auth.js'

const router = Router()
const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'

/**
 * POST /api/proxy/:nsid — proxy a JSON POST to the group service with service auth
 * Body must include `groupDid` which is extracted for the `aud` claim.
 */
router.post('/:nsid', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated', sessionExpired: true })
    }

    const { nsid } = req.params
    const { groupDid, ...body } = req.body

    if (!groupDid) {
      return res.status(400).json({ error: 'Missing groupDid' })
    }

    const jwt = await getServiceAuth(req.session.user, groupDid, nsid, req)

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/${nsid}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json(data)
    }

    res.json(data)
  } catch (err: any) {
    console.error('Proxy POST error:', err.message)
    if (err.message?.includes('refresh') || err.message?.includes('log in again') || err.message?.includes('getServiceAuth failed (401)')) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(500).json({ error: err.message || 'Proxy request failed' })
  }
})

/**
 * GET /api/proxy/:nsid — proxy a query to the group service with service auth
 * Query param `groupDid` is extracted for the `aud` claim.
 */
router.get('/:nsid', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated', sessionExpired: true })
    }

    const { nsid } = req.params
    const { groupDid, ...params } = req.query as Record<string, string>

    if (!groupDid) {
      return res.status(400).json({ error: 'Missing groupDid query param' })
    }

    const jwt = await getServiceAuth(req.session.user, groupDid, nsid, req)

    const queryString = new URLSearchParams(params).toString()
    const url = `${GROUP_SERVICE_URL}/xrpc/${nsid}${queryString ? '?' + queryString : ''}`

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json(data)
    }

    res.json(data)
  } catch (err: any) {
    console.error('Proxy GET error:', err.message)
    if (err.message?.includes('refresh') || err.message?.includes('log in again') || err.message?.includes('getServiceAuth failed (401)')) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(500).json({ error: err.message || 'Proxy request failed' })
  }
})

export default router
