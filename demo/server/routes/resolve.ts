import { Router } from 'express'

const router = Router()
const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'

/**
 * GET /api/resolve?identifier=<did-or-handle>
 *
 * Resolve an at-identifier to a DID so fields can accept either form. A value
 * that already looks like a DID is returned unchanged; a handle is resolved via
 * com.atproto.identity.resolveHandle on the ePDS. Done server-side to avoid
 * cross-origin calls from the browser.
 */
router.get('/', async (req, res) => {
  const identifier = (req.query.identifier as string | undefined)?.trim()
  if (!identifier) {
    return res.status(400).json({ error: 'Missing identifier' })
  }

  // Already a DID — nothing to resolve.
  if (identifier.startsWith('did:')) {
    return res.json({ did: identifier, handle: null })
  }

  // Treat anything else as a handle (strip a leading @ for convenience).
  const handle = identifier.replace(/^@/, '')
  try {
    const url = `${EPDS_URL.replace(/\/$/, '')}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
    const upstream = await fetch(url)
    const data = await upstream.json().catch(() => ({}) as any)
    if (!upstream.ok || !data?.did) {
      return res.status(upstream.ok ? 404 : upstream.status).json({
        error: `Could not resolve handle "${handle}"`,
      })
    }
    res.json({ did: data.did, handle })
  } catch (err: any) {
    res.status(502).json({ error: err?.message || 'Handle resolution failed' })
  }
})

export default router
