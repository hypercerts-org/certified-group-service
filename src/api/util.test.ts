import { describe, it, expect, vi } from 'vitest'
import { XRPCError as ClientXRPCError } from '@atproto/xrpc'
import { XRPCError, UpstreamFailureError } from '@atproto/xrpc-server'
import { proxyToPds } from './util.js'
import type { PdsAgentPool } from '../pds/agent.js'

function makePool(
  withAgentImpl: PdsAgentPool['withAgent'],
): PdsAgentPool {
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
    const pool = makePool(async () => { throw pdsError })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(400)
    expect(err.payload.error).toBe('InvalidRequest')
    expect(err.payload.message).toBe('Record already exists')
  })

  it('forwards 403 Forbidden with original status', async () => {
    const pdsError = new ClientXRPCError(403, 'Forbidden', 'Not allowed')
    const pool = makePool(async () => { throw pdsError })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(403)
    expect(err.payload.error).toBe('Forbidden')
  })

  it('forwards 404 from PDS as 404', async () => {
    const pdsError = new ClientXRPCError(404, 'RepoNotFound', 'Repo not found')
    const pool = makePool(async () => { throw pdsError })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(XRPCError)
    expect(err.type).toBe(404)
    expect(err.payload.error).toBe('RepoNotFound')
  })

  it('wraps 401 as 502 UpstreamFailureError (not forwarded)', async () => {
    const pdsError = new ClientXRPCError(401, 'AuthenticationRequired')
    const pool = makePool(async () => { throw pdsError })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error/)
  })

  it('wraps 500 PDS errors as 502 UpstreamFailureError', async () => {
    const pdsError = new ClientXRPCError(500, 'InternalServerError', 'Something broke')
    const pool = makePool(async () => { throw pdsError })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error/)
  })

  it('wraps network errors as 502 UpstreamFailureError', async () => {
    const pool = makePool(async () => { throw new Error('ECONNREFUSED') })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error: ECONNREFUSED/)
  })

  it('re-throws UpstreamFailureError as-is', async () => {
    const original = new UpstreamFailureError('already wrapped')
    const pool = makePool(async () => { throw original })

    const err = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBe(original)
  })

  it('wraps non-Error thrown values as 502', async () => {
    const pool = makePool(async () => { throw 'string error' })

    const err: any = await proxyToPds(pool, 'did:example:1', async () => 'ok').catch(e => e)
    expect(err).toBeInstanceOf(UpstreamFailureError)
    expect(err.payload.message).toMatch(/Upstream PDS error: string error/)
  })
})
