import type { Server, MethodHandler, RouteOptions } from '@atproto/xrpc-server'
import type { AppContext } from '../context.js'
import type { GroupAuthResult } from '../auth/verifier.js'

interface MethodConfig {
  opts?: RouteOptions
  handler: MethodHandler<GroupAuthResult>
}

export function registerAuthedMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: MethodConfig,
): void {
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcAuth(),
    ...(config.opts && { opts: config.opts }),
    handler: config.handler,
  })
}
