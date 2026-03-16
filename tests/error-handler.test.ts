import { describe, it, expect, vi } from 'vitest'
import { XRPCError } from '@atproto/xrpc-server'
import { xrpcErrorHandler } from '../src/api/error-handler.js'

function makeMocks() {
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const handler = xrpcErrorHandler(logger as any)
  const req = {} as any
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any
  const next = vi.fn()
  return { logger, handler, req, res, next }
}

describe('xrpcErrorHandler', () => {
  it('XRPCError returns correct status and payload', () => {
    const { handler, req, res, next } = makeMocks()
    const err = new XRPCError(400, 'Bad input', 'InvalidRequest')
    handler(err, req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'InvalidRequest', message: 'Bad input' }),
    )
  })

  it('XRPCError 403 returns 403', () => {
    const { handler, req, res, next } = makeMocks()
    handler(new XRPCError(403, 'Forbidden', 'Forbidden'), req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('generic Error returns 500', () => {
    const { handler, req, res, next } = makeMocks()
    handler(new Error('something broke'), req, res, next)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' })
  })

  it('generic Error is logged', () => {
    const { handler, logger, req, res, next } = makeMocks()
    const err = new Error('something broke')
    handler(err, req, res, next)
    expect(logger.error).toHaveBeenCalledWith(err, 'Unhandled error')
  })

  it('non-Error thrown returns 500', () => {
    const { handler, req, res, next } = makeMocks()
    handler('string error', req, res, next)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'InternalServerError', message: 'Internal server error' })
  })
})
