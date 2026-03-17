import type { Response } from 'express'
import { Router } from 'express'
import { createProxyAgent, isSessionExpiredError } from '../oauth/proxy-agent.js'

const router = Router()

function handleProxyError(res: Response, err: any) {
  if (isSessionExpiredError(err)) {
    return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
  }
  res.status(err.status || 500).json({ error: err.message || 'Proxy request failed' })
}

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
    handleProxyError(res, err)
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
    handleProxyError(res, err)
  }
})

export default router
