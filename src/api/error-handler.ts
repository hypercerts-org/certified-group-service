import { XRPCError } from '@atproto/xrpc-server'
import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'

export function xrpcErrorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof XRPCError) {
      res.status(err.statusCode).json(err.payload)
      return
    }
    logger.error(err, 'Unhandled error')
    res.status(500).json({ error: 'InternalServerError', message: 'Internal server error' })
  }
}
