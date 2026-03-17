import { Router } from 'express'
import { createProxyAgent, isSessionExpiredError } from '../oauth/proxy-agent.js'

const router = Router()

/**
 * POST /api/proxy/:nsid — proxy a JSON POST to the group service via atproto-proxy
 * Body must include `groupDid` which is used to route the proxy.
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

    const agent = createProxyAgent(req.session.user, groupDid, req)
    const response = await agent.call(nsid, {}, body, { encoding: 'application/json' })
    res.json(response.data)
  } catch (err: any) {
    console.error('Proxy POST error:', err.message)
    if (isSessionExpiredError(err)) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(err.status || 500).json({ error: err.message || 'Proxy request failed' })
  }
})

/**
 * GET /api/proxy/:nsid — proxy a query to the group service via atproto-proxy
 * Query param `groupDid` is used to route the proxy.
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

    const agent = createProxyAgent(req.session.user, groupDid, req)
    const response = await agent.call(nsid, params)
    res.json(response.data)
  } catch (err: any) {
    console.error('Proxy GET error:', err.message)
    if (isSessionExpiredError(err)) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(err.status || 500).json({ error: err.message || 'Proxy request failed' })
  }
})

export default router
