import { XRPCError, AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'

/** Resolve the `repo` at-identifier to a known group DID. */
export async function resolveGroup(ctx: AppContext, repo: string): Promise<string> {
  try {
    return await ctx.authVerifier.resolveRepoToGroup(repo)
  } catch (err) {
    // resolveRepoToGroup throws AuthRequiredError specifically when the repo
    // does not resolve to a managed group. Map only that to UnknownGroup; let
    // unexpected failures (e.g. a transient resolver error) surface as-is so
    // they aren't misdiagnosed as a bad group DID.
    if (err instanceof AuthRequiredError) {
      throw new XRPCError(404, `Unknown group: ${repo}`, 'UnknownGroup')
    }
    throw err
  }
}
