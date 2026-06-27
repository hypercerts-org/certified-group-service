import { useEffect, useState } from 'react'
import { resolveHandles } from './api'

// Matches the server-side cap in server/routes/resolve.ts so we never send a
// batch the server would silently truncate — instead we send one cap-sized
// batch per round and let the effect re-run for the remainder.
const MAX_BATCH = 100

/**
 * Reverse-resolve a set of DIDs to handles for display, returning a `did →
 * handle | null` map. Used by views that list member/actor DIDs (Dashboard,
 * Audit) so they can lead with the handle and keep the DID secondary.
 *
 * Resolution is best-effort: the map starts empty (callers fall back to the DID
 * via {@link HandleId}) and fills in as it resolves. Only DIDs not already
 * resolved are fetched. When more than one batch is needed (> MAX_BATCH unknown
 * DIDs), each completed batch grows `handles`, which re-runs the effect for the
 * next batch until none remain. A failed batch is swallowed — the UI keeps
 * showing DIDs.
 */
export function useHandles(dids: string[]): Record<string, string | null> {
  const [handles, setHandles] = useState<Record<string, string | null>>({})

  // Stable dependency: the sorted set of DIDs, so the effect only re-runs when
  // the actual DID set changes (not on every array identity), plus the resolved
  // count so a completed batch triggers the next one for any remainder.
  const key = [...new Set(dids)].sort().join(',')
  const resolvedCount = Object.keys(handles).length

  useEffect(() => {
    const unique = [...new Set(dids)].filter((d) => d && d.startsWith('did:'))
    const missing = unique.filter((d) => !(d in handles)).slice(0, MAX_BATCH)
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
    // `key` + `resolvedCount` capture the meaningful changes; `handles`/`dids`
    // are read inside and need not trigger on identity alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolvedCount])

  return handles
}
