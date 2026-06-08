import { Router } from 'express'

const router = Router()

const ALLOWED_METHODS = ['GET', 'POST'] as const
type AllowedMethod = (typeof ALLOWED_METHODS)[number]
const UPSTREAM_TIMEOUT_MS = 15_000

/**
 * POST /api/keys/call — exercise an API key.
 *
 * Unlike the proxy route, this path uses NO owner session and NO atproto-proxy:
 * the API key IS the credential. The BFF makes a direct call to the group
 * service with the `X-API-Key` header so the demo can show that a key works on
 * its own. `repo` rides the querystring — required on the key path, even for
 * write procedures (the service resolves the group before the body is parsed).
 *
 * Body: { key, nsid, repo, method?, body? }
 */
router.post('/call', async (req, res) => {
  const { key, nsid, repo, method = 'GET', body } = req.body as {
    key?: string
    nsid?: string
    repo?: string
    method?: 'GET' | 'POST'
    body?: unknown
  }

  if (!key || !nsid || !repo) {
    return res.status(400).json({ error: 'key, nsid and repo are required' })
  }

  // Validate `method` at runtime — the TS type is not enforced on the wire, and
  // this route must not forward arbitrary verbs upstream.
  if (!ALLOWED_METHODS.includes(method as AllowedMethod)) {
    return res.status(400).json({ error: `method must be one of ${ALLOWED_METHODS.join(', ')}` })
  }
  const verb = method as AllowedMethod

  const base = process.env.GROUP_SERVICE_URL
  if (!base) {
    return res.status(500).json({ error: 'GROUP_SERVICE_URL not configured' })
  }

  const url = `${base.replace(/\/$/, '')}/xrpc/${nsid}?repo=${encodeURIComponent(repo)}`

  // Bound the upstream call so a hung group service can't tie up a worker.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'X-API-Key': key }
    if (verb === 'POST' && body !== undefined) headers['Content-Type'] = 'application/json'

    const upstream = await fetch(url, {
      method: verb,
      headers,
      body: verb === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    const text = await upstream.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }

    // Surface the group service's status + payload to the page so the demo can
    // show both a success and a scope-denied (403) outcome.
    res.json({ status: upstream.status, data })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'group service did not respond in time' })
    }
    res.status(502).json({ error: err?.message || 'API-key call failed' })
  } finally {
    clearTimeout(timer)
  }
})

export default router
