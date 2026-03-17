import type { Server, MethodHandler, RouteOptions } from '@atproto/xrpc-server'
import type { AppContext } from '../context.js'
import type { GroupAuthResult } from '../auth/verifier.js'

interface AuthedMethodConfig {
  opts?: RouteOptions
  handler: MethodHandler<GroupAuthResult>
}

export function registerAuthedMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: AuthedMethodConfig,
): void {
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcAuth(),
    opts: config.opts,
    handler: config.handler,
  })
}
