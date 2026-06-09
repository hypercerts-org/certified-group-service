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
 * `params` (GET queries only) are appended to the querystring alongside `repo`,
 * so a query method like audit.query can be exercised with its filters. They are
 * ignored for POST, whose inputs travel in `body`.
 *
 * Body: { key, nsid, repo, method?, body?, params? }
 */
router.post('/call', async (req, res) => {
  const { key, nsid, repo, method = 'GET', body, params } = req.body as {
    key?: string
    nsid?: string
    repo?: string
    method?: 'GET' | 'POST'
    body?: unknown
    params?: Record<string, unknown>
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

  // Collect GET query filters, then force `repo` in last so a caller-supplied
  // `repo` param can never override the top-level one (confused-deputy: it would
  // retarget the call at a different group). Non-primitive values are rejected
  // rather than String()'d into junk like `[object Object]`.
  const filtered: Record<string, string> = {}
  if (verb === 'GET' && params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      if (k === 'repo') continue
      if (v === undefined || v === null || v === '') continue
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        return res.status(400).json({ error: `param "${k}" must be a primitive value` })
      }
      filtered[k] = String(v)
    }
  }
  const query = new URLSearchParams({ ...filtered, repo })
  const url = `${base.replace(/\/$/, '')}/xrpc/${nsid}?${query.toString()}`

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
