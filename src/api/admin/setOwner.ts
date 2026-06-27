import type { Server } from '@atproto/xrpc-server'
import { XRPCError, AuthRequiredError } from '@atproto/xrpc-server'
import { ensureValidDid } from '@atproto/syntax'
import type { AppContext } from '../../context.js'
import { registerAdminMethod, jsonResponse } from '../util.js'

/**
 * app.certified.group.admin.setOwner — operator-only ownership reassignment.
 *
 * Authenticated by HTTP Basic auth against CGS_ADMIN_PASSWORD (see
 * registerAdminMethod), NOT group membership. This is the in-process equivalent
 * of the former direct-DB script: because it writes through the same
 * GroupDbPool connection the read paths use, the change is visible immediately —
 * no service restart required.
 *
 * The previous owner (if any) is demoted to admin; the new owner is promoted to
 * owner. The new owner must already be a member — unlike a self-service role
 * change, but creating membership as a side effect of an ownership transfer
 * would be surprising for an admin tool, so we require it explicitly.
 */
export default function (server: Server, ctx: AppContext) {
  registerAdminMethod(server, 'app.certified.group.admin.setOwner', ctx, {
    handler: async ({ input }) => {
      const { repo, newOwner } = input?.body as { repo: string; newOwner: string }

      // Resolve the group (validates it is a managed group) and the new owner's
      // DID (handle → DID via the resolver) in parallel.
      const [groupDid, newOwnerDid] = await Promise.all([
        resolveGroup(ctx, repo),
        resolveNewOwner(ctx, newOwner),
      ])

      const groupDb = ctx.groupDbs.get(groupDid)

      const [currentOwner, target] = await Promise.all([
        groupDb
          .selectFrom('group_members')
          .select('member_did')
          .where('role', '=', 'owner')
          .executeTakeFirst(),
        groupDb
          .selectFrom('group_members')
          .select('role')
          .where('member_did', '=', newOwnerDid)
          .executeTakeFirst(),
      ])

      // Already the owner — nothing to do. Report it rather than churn the DB.
      if (currentOwner?.member_did === newOwnerDid) {
        await ctx.audit.log(groupDb, 'admin', 'admin.setOwner', 'permitted', {
          newOwner: newOwnerDid,
          previousOwner: newOwnerDid,
          noop: true,
        })
        return jsonResponse({
          groupDid,
          owner: newOwnerDid,
          noop: true,
          updatedAt: new Date().toISOString(),
        })
      }

      // The new owner need NOT already be a member: this is an operator
      // break-glass endpoint, used precisely when the incumbent owner/admin is
      // unavailable (lost keys, incapacitated) and a fresh owner must be
      // installed. If they aren't a member, add them as owner; otherwise promote
      // in place. Either way the previous owner (if any) is demoted to admin.
      const addedAsMember = !target
      const previousOwner = currentOwner?.member_did ?? null
      ctx.memberIndex.transferOwner(
        ctx.groupDbs.getRaw(groupDid),
        groupDid,
        newOwnerDid,
        previousOwner,
      )

      await ctx.audit.log(groupDb, 'admin', 'admin.setOwner', 'permitted', {
        newOwner: newOwnerDid,
        previousOwner,
        addedAsMember,
      })

      // updatedAt is the time of this operation, consistent with the no-op
      // branch — not the new owner's (older) original join time.
      return jsonResponse({
        groupDid,
        owner: newOwnerDid,
        ...(previousOwner ? { previousOwner } : {}),
        addedAsMember,
        noop: false,
        updatedAt: new Date().toISOString(),
      })
    },
  })
}

/** Resolve the `repo` at-identifier to a known group DID. */
async function resolveGroup(ctx: AppContext, repo: string): Promise<string> {
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

/** Resolve the `newOwner` at-identifier (handle or DID) to a DID. */
async function resolveNewOwner(ctx: AppContext, newOwner: string): Promise<string> {
  if (newOwner.startsWith('did:')) {
    try {
      ensureValidDid(newOwner)
    } catch {
      throw new XRPCError(400, `Invalid newOwner DID: ${newOwner}`, 'InvalidRequest')
    }
    return newOwner
  }
  const did = await ctx.idResolver.handle.resolve(newOwner)
  if (!did) {
    throw new XRPCError(400, `Could not resolve newOwner handle: ${newOwner}`, 'InvalidRequest')
  }
  return did
}
