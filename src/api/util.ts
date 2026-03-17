import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../context.js'
import type { GroupAuthCredentials } from '../auth/verifier.js'

interface MethodConfig {
  opts?: { blobLimit?: number }
  handler: (ctx: {
    auth: { credentials: GroupAuthCredentials }
    input?: { body: unknown; encoding?: string }
    params: Record<string, unknown>
    req: import('express').Request
    res: import('express').Response
  }) => Promise<{ encoding: string; body: unknown }>
}

export function registerAuthedMethod(
  server: Server,
  nsid: string,
  ctx: AppContext,
  config: MethodConfig,
): void {
  server.method(nsid, {
    auth: ctx.authVerifier.xrpcAuth(),
    ...(config.opts ? { opts: config.opts } : {}),
    handler: config.handler as never,
  })
}
