import type { Response } from 'express'
import { Router } from 'express'
import { callGroupService, isSessionExpiredError } from '../oauth/proxy-agent.js'

const router = Router()

// Service-level methods name no target group — the group service resolves the
// caller from the JWT `iss` alone. Every other method must carry a `groupDid`,
// so a forgotten target is caught here rather than failing deeper upstream.
const GROUPLESS_METHODS = new Set(['app.certified.groups.membership.list'])

function handleProxyError(res: Response, err: any) {
  if (isSessionExpiredError(err)) {
    return res
      .status(401)
      .json({ error: 'Session expired — please log in again', sessionExpired: true })
  }
  const httpStatus = err.status >= 100 ? err.status : 502
  res.status(httpStatus).json({ error: err.message || 'Proxy request failed' })
}

/**
 * POST /api/proxy/:nsid — call a group-service procedure.
 * Body must include `groupDid` (the target group); the rest is the XRPC input.
 * Authenticated with a service-auth JWT (see callGroupService) rather than the
 * atproto service-proxy, which depends on fresh PDS DID-document caching.
 */
router.post('/:nsid', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated', sessionExpired: true })
    }

    const { nsid } = req.params
    const { groupDid, ...body } = req.body

    if (!groupDid && !GROUPLESS_METHODS.has(nsid)) {
      return res.status(400).json({ error: 'Missing groupDid' })
    }

    const { status, data } = await callGroupService(req.session.user.did, groupDid, nsid, {
      method: 'POST',
      body,
    })
    res.status(status).json(data)
  } catch (err: any) {
    handleProxyError(res, err)
  }
})

/**
 * GET /api/proxy/:nsid — call a group-service query.
 * Query param `groupDid` is the target group; the rest are XRPC params.
 */
router.get('/:nsid', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated', sessionExpired: true })
    }

    const { nsid } = req.params
    const { groupDid, ...params } = req.query as Record<string, string>

    if (!groupDid && !GROUPLESS_METHODS.has(nsid)) {
      return res.status(400).json({ error: 'Missing groupDid query param' })
    }

    const { status, data } = await callGroupService(req.session.user.did, groupDid, nsid, {
      method: 'GET',
      params,
    })
    res.status(status).json(data)
  } catch (err: any) {
    handleProxyError(res, err)
  }
})

export default router
