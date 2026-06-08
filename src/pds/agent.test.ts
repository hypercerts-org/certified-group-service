import { describe, it, expect, vi, beforeEach } from 'vitest'
import { XRPCError } from '@atproto/xrpc'
import { PdsAgentPool } from './agent.js'
import type { Agent } from '@atproto/api'

// Minimal fake db — get() is always mocked so _login() never runs
const fakeDb = {} as never
const fakeKey = Buffer.alloc(32)

function makeAgent(): Agent {
  return {} as Agent
}

describe('PdsAgentPool.withAgent', () => {
  let pool: PdsAgentPool

  beforeEach(() => {
    pool = new PdsAgentPool(fakeDb, fakeKey)
  })

  it('retries once on 401 XRPCError and calls fn twice', async () => {
    const firstAgent = makeAgent()
    const secondAgent = makeAgent()

    // get() returns firstAgent first, then secondAgent after invalidation
    vi.spyOn(pool, 'get').mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(secondAgent)

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new XRPCError(401, 'AuthenticationRequired'))
      .mockResolvedValueOnce('ok')

    const result = await pool.withAgent('did:example:1', fn)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenNthCalledWith(1, firstAgent)
    expect(fn).toHaveBeenNthCalledWith(2, secondAgent)
    expect(result).toBe('ok')
  })

  it('retries once on ExpiredToken XRPCError and calls fn twice', async () => {
    const firstAgent = makeAgent()
    const secondAgent = makeAgent()

    vi.spyOn(pool, 'get').mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(secondAgent)

    const expiredError = new XRPCError(400, 'ExpiredToken')
    const fn = vi.fn().mockRejectedValueOnce(expiredError).mockResolvedValueOnce('retried')

    const result = await pool.withAgent('did:example:2', fn)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(result).toBe('retried')
  })

  it('does not retry and rethrows non-auth errors', async () => {
    const agent = makeAgent()
    vi.spyOn(pool, 'get').mockResolvedValue(agent)

    const networkError = new Error('Network failure')
    const fn = vi.fn().mockRejectedValue(networkError)

    await expect(pool.withAgent('did:example:3', fn)).rejects.toThrow('Network failure')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-401 XRPCErrors', async () => {
    const agent = makeAgent()
    vi.spyOn(pool, 'get').mockResolvedValue(agent)

    const forbiddenError = new XRPCError(403, 'Forbidden')
    const fn = vi.fn().mockRejectedValue(forbiddenError)

    await expect(pool.withAgent('did:example:4', fn)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('invalidates the cached agent before retrying', async () => {
    const firstAgent = makeAgent()
    const secondAgent = makeAgent()

    const getSpy = vi
      .spyOn(pool, 'get')
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent)

    const invalidateSpy = vi.spyOn(pool, 'invalidate')

    const fn = vi.fn().mockRejectedValueOnce(new XRPCError(401)).mockResolvedValueOnce('done')

    await pool.withAgent('did:example:5', fn)

    expect(invalidateSpy).toHaveBeenCalledWith('did:example:5')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})
