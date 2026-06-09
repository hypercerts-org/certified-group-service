import { Router } from 'express'

const router = Router()
const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'
const PLC_URL = process.env.PLC_URL || 'https://plc.directory'
// Bound DID-document fetches so a stalled host can't tie up a BFF worker
// (mirrors the AbortController pattern in routes/keys.ts).
const DOC_FETCH_TIMEOUT_MS = 5_000

/**
 * Resolve a DID to its primary handle by reading the DID document's
 * `alsoKnownAs` (the first `at://` entry, per atproto convention). Returns null
 * when the DID does not resolve or declares no handle — callers fall back to
 * showing the DID. Only `did:plc:` (via the PLC directory) and `did:web:` on a
 * public host (via `/.well-known/did.json`) are supported; anything else
 * returns null. The fetch is time-bounded.
 */
async function didToHandle(did: string): Promise<string | null> {
  const docUrl = didDocumentUrl(did)
  if (!docUrl) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOC_FETCH_TIMEOUT_MS)
  try {
    const upstream = await fetch(docUrl, { signal: controller.signal })
    if (!upstream.ok) return null
    const doc = (await upstream.json().catch(() => null)) as { alsoKnownAs?: unknown } | null
    const aka = Array.isArray(doc?.alsoKnownAs) ? doc.alsoKnownAs : []
    const atUri = aka.find((v): v is string => typeof v === 'string' && v.startsWith('at://'))
    return atUri ? atUri.slice('at://'.length) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reject `did:web` hosts that point at the local network. The BFF fetches the
 * DID document server-side, so an attacker-supplied `did:web:` could otherwise
 * coax it into requesting an internal address (SSRF). This is a syntactic guard
 * — it blocks the obvious internal targets (loopback, RFC1918, link-local,
 * `.local`/`.internal`, bare/no-dot hosts) without doing DNS resolution.
 */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase()
  if (!h || !h.includes('.')) return false // bare hostnames (e.g. "localhost")
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (h === '127.0.0.1' || h.startsWith('127.') || h === '0.0.0.0' || h === '::1') return false
  // RFC1918 / link-local IPv4 ranges.
  if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/** The URL of a DID's document, or null for an unsupported/unsafe DID. */
export function didDocumentUrl(did: string): string | null {
  if (did.startsWith('did:plc:')) {
    return `${PLC_URL.replace(/\/$/, '')}/${encodeURIComponent(did)}`
  }
  if (did.startsWith('did:web:')) {
    // did:web:<host>[:<path>] → https://<host>[/<path>]/.well-known/did.json.
    // decodeURIComponent throws on malformed percent-encoding; treat that (and
    // a non-public host) as "no document" rather than letting it propagate.
    try {
      const parts = did.slice('did:web:'.length).split(':').map(decodeURIComponent)
      const host = parts[0]
      if (!isPublicHost(host)) return null
      const path = parts.slice(1).join('/')
      const base = path ? `https://${host}/${path}` : `https://${host}`
      return `${base}/.well-known/did.json`
    } catch {
      return null
    }
  }
  return null
}

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

const MAX_BATCH = 100

/**
 * POST /api/resolve/handles  body: { dids: string[] }
 *
 * Reverse-resolve a batch of DIDs to their handles for display (handle-primary,
 * DID-secondary in the UI). Returns `{ handles: { [did]: handle | null } }`;
 * a DID that does not resolve maps to null so the caller shows the DID instead.
 * Resolution is best-effort and per-DID independent — one failure never fails
 * the batch. Done server-side to keep DID-doc fetches off the browser.
 */
router.post('/handles', async (req, res) => {
  const raw = (req.body as { dids?: unknown })?.dids
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'Body must be { dids: string[] }' })
  }
  // De-duplicate and keep only well-formed DID strings, capped to bound fan-out.
  const dids = [...new Set(raw.filter((d): d is string => typeof d === 'string' && d.startsWith('did:')))].slice(
    0,
    MAX_BATCH,
  )

  const entries = await Promise.all(
    dids.map(async (did) => {
      try {
        return [did, await didToHandle(did)] as const
      } catch {
        return [did, null] as const
      }
    }),
  )

  res.json({ handles: Object.fromEntries(entries) })
})

export default router
