import { describe, it, expect } from 'vitest'
import { XRPCError as ClientXRPCError } from '@atproto/xrpc'
import { XRPCError, UpstreamFailureError } from '@atproto/xrpc-server'
import { proxyToPds, rateLimitAllow } from './util.js'
import type { PdsAgentPool } from '../pds/agent.js'

function makePool(withAgentImpl: PdsAgentPool['withAgent']): PdsAgentPool {
  return { withAgent: withAgentImpl } as unknown as PdsAgentPool
}

describe('proxyToPds', () => {
  it('returns the PDS result on success', async () => {
    const pool = makePool(async (_did, fn) => fn({} as any))
    const result = await proxyToPds(pool, 'did:example:1', async () => 'ok')
    expect(result).toBe('ok')
  })

  it('forwards 400 InvalidRequest with original status and error name', async () => {
    const pdsError = new ClientXRPCError(400, 'InvalidRequest', 'Record already exists')
    const pool = makePool(async () => {
      throw pdsError
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(400)
    expect(err.payload.error).toBe('InvalidRequest')
    expect(err.payload.message).toBe('Record already exists')
  })

  it('forwards 403 Forbidden with original status', async () => {
    const pdsError = new ClientXRPCError(403, 'Forbidden', 'Not allowed')
    const pool = makePool(async () => {
      throw pdsError
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(403)
    expect(err.payload.error).toBe('Forbidden')
  })

  it('forwards 404 from PDS as 404', async () => {
    const pdsError = new ClientXRPCError(404, 'RepoNotFound', 'Repo not found')
    const pool = makePool(async () => {
      throw pdsError
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(404)
    expect(err.payload.error).toBe('RepoNotFound')
  })

  it('wraps 401 as 502 UpstreamFailureError (not forwarded)', async () => {
    const pdsError = new ClientXRPCError(401, 'AuthenticationRequired')
    const pool = makePool(async () => {
      throw pdsError
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error/)
  })

  it('wraps 500 PDS errors as 502 UpstreamFailureError', async () => {
    const pdsError = new ClientXRPCError(500, 'InternalServerError', 'Something broke')
    const pool = makePool(async () => {
      throw pdsError
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error/)
  })

  it('wraps network errors as 502 UpstreamFailureError', async () => {
    const pool = makePool(async () => {
      throw new Error('ECONNREFUSED')
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error: ECONNREFUSED/)
  })

  it('re-throws UpstreamFailureError as-is', async () => {
    const original = new UpstreamFailureError('already wrapped')
    const pool = makePool(async () => {
      throw original
    })

    const err = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBe(original)
  })

  it('wraps non-Error thrown values as 502', async () => {
    const pool = makePool(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately throwing a non-Error to test the wrapping path
      throw 'string error'
    })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error: string error/)
  })
})

describe('rateLimitAllow', () => {
  const WINDOW = 1000
  const CAP = 1000

  it('allows the first time a key is seen and records it', () => {
    const map = new Map<string, number>()
    expect(rateLimitAllow(map, 'a', 0, WINDOW, CAP)).toBe(true)
    expect(map.get('a')).toBe(0)
  })

  it('suppresses a repeat within the window', () => {
    const map = new Map<string, number>([['a', 0]])
    expect(rateLimitAllow(map, 'a', WINDOW - 1, WINDOW, CAP)).toBe(false)
    // timestamp is unchanged when suppressed
    expect(map.get('a')).toBe(0)
  })

  it('allows again once the window has elapsed and refreshes the timestamp', () => {
    const map = new Map<string, number>([['a', 0]])
    expect(rateLimitAllow(map, 'a', WINDOW, WINDOW, CAP)).toBe(true)
    expect(map.get('a')).toBe(WINDOW)
  })

  it('sweeps expired entries before growing past the cap', () => {
    // Two stale entries (older than the window) + one fresh, at the cap of 3.
    const map = new Map<string, number>([
      ['stale1', 0],
      ['stale2', 0],
      ['fresh', 5000],
    ])
    // now is well past the window for the stale pair but within it for `fresh`.
    const allowed = rateLimitAllow(map, 'new', 5500, WINDOW, 3)
    expect(allowed).toBe(true)
    // The two expired entries were evicted; the fresh one and the new key remain.
    expect(map.has('stale1')).toBe(false)
    expect(map.has('stale2')).toBe(false)
    expect(map.has('fresh')).toBe(true)
    expect(map.get('new')).toBe(5500)
  })

  it('does not sweep below the cap', () => {
    const map = new Map<string, number>([['old', 0]])
    // Under the cap (1 < 3), so the expired entry is left in place, not swept.
    rateLimitAllow(map, 'new', 5000, WINDOW, 3)
    expect(map.has('old')).toBe(true)
  })

  it('hard-caps by evicting the oldest when all entries are still fresh', () => {
    // At the cap of 3, every entry within the window — nothing to sweep.
    const map = new Map<string, number>([
      ['a', 100],
      ['b', 200],
      ['c', 300],
    ])
    const allowed = rateLimitAllow(map, 'd', 350, WINDOW, 3)
    expect(allowed).toBe(true)
    // Oldest by insertion order ('a') evicted; size stays at the cap.
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(false)
    expect(map.has('d')).toBe(true)
  })

  it('re-warning an existing key at the cap does not evict (no growth)', () => {
    const map = new Map<string, number>([
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ])
    // 'a' is at the cap but already present and its window has elapsed: it
    // refreshes in place without evicting anyone.
    const allowed = rateLimitAllow(map, 'a', WINDOW, WINDOW, 3)
    expect(allowed).toBe(true)
    expect(map.size).toBe(3)
    expect(map.has('b')).toBe(true)
    expect(map.has('c')).toBe(true)
    expect(map.get('a')).toBe(WINDOW)
  })
})
