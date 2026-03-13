import type { Request, Response, NextFunction } from 'express'
import type { AppContext } from '../context.js'

export function xrpcHandler(
  ctx: AppContext,
  fn: (req: Request, res: Response, auth: { callerDid: string; groupDid: string }) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { iss: callerDid, aud: groupDid } = await ctx.authVerifier.verify(req)
      await fn(req, res, { callerDid, groupDid })
    } catch (err) {
      next(err)
    }
  }
}
