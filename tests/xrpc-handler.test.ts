import { describe, it, expect, vi } from 'vitest'
import { xrpcHandler } from '../src/api/util.js'

function makeMocks(verifyResult: any = { iss: 'did:plc:a', aud: 'did:plc:b' }) {
  const ctx = {
    authVerifier: {
      verify: vi.fn().mockResolvedValue(verifyResult),
    },
  } as any
  const req = {} as any
  const res = {} as any
  const next = vi.fn()
  return { ctx, req, res, next }
}

describe('xrpcHandler', () => {
  it('calls authVerifier.verify and passes iss/aud to handler', async () => {
    const { ctx, req, res, next } = makeMocks()
    const handler = vi.fn()
    const middleware = xrpcHandler(ctx, handler)

    await middleware(req, res, next)

    expect(ctx.authVerifier.verify).toHaveBeenCalledWith(req)
    expect(handler).toHaveBeenCalledWith(req, res, { callerDid: 'did:plc:a', groupDid: 'did:plc:b' })
  })

  it('auth failure passes error to next()', async () => {
    const ctx = {
      authVerifier: { verify: vi.fn().mockRejectedValue(new Error('auth failed')) },
    } as any
    const handler = vi.fn()
    const next = vi.fn()

    await xrpcHandler(ctx, handler)({} as any, {} as any, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'auth failed' }))
    expect(handler).not.toHaveBeenCalled()
  })

  it('handler exception passed to next()', async () => {
    const { ctx, req, res, next } = makeMocks()
    const handler = vi.fn().mockRejectedValue(new Error('boom'))

    await xrpcHandler(ctx, handler)(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })

  it('async handler rejection passed to next()', async () => {
    const { ctx, req, res, next } = makeMocks()
    const handler = vi.fn().mockImplementation(() => Promise.reject(new Error('async boom')))

    await xrpcHandler(ctx, handler)(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'async boom' }))
  })
})
