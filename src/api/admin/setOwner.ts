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

      // The ownership read, the transfer and the proposal invalidation run as
      // one unit against this group's member-initiated transfer flow: a propose
      // interleaved here would either be written by an owner this call has
      // already demoted, or survive the clear below and let a stale proposal
      // revert the reassignment. Resolution above is outside the lock, so no
      // network call is made while holding it.
      const outcome = await ctx.ownershipLock.run(groupDid, async () => {
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
          return { noop: true as const }
        }

        // The new owner need NOT already be a member: this is an operator
        // break-glass endpoint, used precisely when the incumbent owner/admin is
        // unavailable (lost keys, incapacitated) and a fresh owner must be
        // installed. If they aren't a member, add them as owner; otherwise promote
        // in place. Either way the previous owner (if any) is demoted to admin.
        const addedAsMember = !target
        const previousOwner = currentOwner?.member_did ?? null

        // Invalidate any member-initiated pending transfer: ownership is about to
        // move out of band. Without this, a stale proposal made by the (now
        // demoted) owner could be accepted within its TTL and silently revert this
        // operator reassignment — the exact break-glass case setOwner exists for.
        //
        // Before the transfer, not after. The two are separate transactions —
        // folding the clear into MemberIndex's cross-DB transaction would couple a
        // member-index primitive to this feature's table — so one can commit
        // without the other if the process dies in between. In this order that
        // leaves a group whose ownership did not move and whose proposal is gone:
        // the owner re-proposes. The reverse order leaves the new owner installed
        // and the old owner's proposal still acceptable after a restart, which is
        // the failure this clear exists to prevent. The lock keeps a concurrent
        // propose out of the gap either way.
        //
        // Deleting unconditionally is safe under the lock: only the owner may
        // propose, so any row present was written by the owner this call is
        // demoting.
        await ctx.pendingTransfers.clear(groupDb)

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

        return { noop: false as const, previousOwner, addedAsMember }
      })

      if (outcome.noop) {
        return jsonResponse({
          groupDid,
          owner: newOwnerDid,
          noop: true,
          updatedAt: new Date().toISOString(),
        })
      }

      // updatedAt is the time of this operation, consistent with the no-op
      // branch — not the new owner's (older) original join time.
      return jsonResponse({
        groupDid,
        owner: newOwnerDid,
        ...(outcome.previousOwner ? { previousOwner: outcome.previousOwner } : {}),
        addedAsMember: outcome.addedAsMember,
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
