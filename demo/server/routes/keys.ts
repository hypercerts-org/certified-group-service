import { Router } from 'express'

const router = Router()

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

  const base = process.env.GROUP_SERVICE_URL
  if (!base) {
    return res.status(500).json({ error: 'GROUP_SERVICE_URL not configured' })
  }

  const url = `${base.replace(/\/$/, '')}/xrpc/${nsid}?repo=${encodeURIComponent(repo)}`

  try {
    const headers: Record<string, string> = { 'X-API-Key': key }
    if (method === 'POST' && body !== undefined) headers['Content-Type'] = 'application/json'

    const upstream = await fetch(url, {
      method,
      headers,
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
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
    res.status(502).json({ error: err?.message || 'API-key call failed' })
  }
})

export default router
