import type { Response } from 'express'
import { Router } from 'express'
import { callGroupService, isSessionExpiredError } from '../oauth/group-client.js'

const router = Router()

function handleError(res: Response, err: any) {
  if (isSessionExpiredError(err)) {
    return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
  }
  res.status(err.status || 500).json({ error: err.message || 'Request failed' })
}

/**
 * POST /api/proxy/:nsid — call the group service directly with service auth
 * Body must include `groupDid` which identifies the target group.
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

    const result = await callGroupService({
      session: req.session.user,
      groupDid,
      nsid,
      method: 'POST',
      body,
      req,
    })
    res.json(result.data)
  } catch (err: any) {
    handleError(res, err)
  }
})

/**
 * GET /api/proxy/:nsid — query the group service directly with service auth
 * Query param `groupDid` identifies the target group.
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

    const result = await callGroupService({
      session: req.session.user,
      groupDid,
      nsid,
      method: 'GET',
      params,
      req,
    })
    res.json(result.data)
  } catch (err: any) {
    handleError(res, err)
  }
})

export default router
