import { useEffect, useState } from 'react'
import { resolveHandles } from './api'

/**
 * Reverse-resolve a set of DIDs to handles for display, returning a `did →
 * handle | null` map. Used by views that list member/actor DIDs (Dashboard,
 * Audit) so they can lead with the handle and keep the DID secondary.
 *
 * Resolution is best-effort: the map starts empty (callers fall back to the DID
 * via {@link HandleId}) and fills in as it resolves. Only DIDs not already
 * resolved are fetched, so re-renders with the same DIDs cost nothing. A failed
 * batch is swallowed — the UI simply keeps showing DIDs.
 */
export function useHandles(dids: string[]): Record<string, string | null> {
  const [handles, setHandles] = useState<Record<string, string | null>>({})

  // Stable dependency: the sorted set of DIDs, so the effect only re-runs when
  // the actual DID set changes, not on every array identity change.
  const key = [...new Set(dids)].sort().join(',')

  useEffect(() => {
    const unique = [...new Set(dids)].filter((d) => d && d.startsWith('did:'))
    const missing = unique.filter((d) => !(d in handles))
    if (missing.length === 0) return

    let cancelled = false
    resolveHandles(missing)
      .then((res) => {
        if (!cancelled) setHandles((prev) => ({ ...prev, ...res.handles }))
      })
      .catch(() => {
        // Best-effort: leave the missing DIDs unresolved; HandleId shows the DID.
      })
    return () => {
      cancelled = true
    }
    // `key` captures the meaningful change; `handles`/`dids` are read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return handles
}
