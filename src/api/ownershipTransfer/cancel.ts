import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, resolveGroupDid } from '../util.js'

/**
 * app.certified.group.ownershipTransfer.cancel — abandon a pending transfer.
 *
 * Either party may cancel: the current owner (revoking their own proposal) or
 * the proposed new owner (declining). Ownership does not move; the pending
 * proposal is simply cleared. A member floor plus the in-handler identity check
 * is the gate — a bystanding member or admin cannot cancel someone else's
 * transfer.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.ownershipTransfer.cancel', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes, apiKeyRef } = auth.credentials
      const { repo } = (input?.body ?? {}) as { repo?: string }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      await assertCanWithAudit(ctx, groupDb, callerDid, 'ownershipTransfer.cancel', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      // Serialized against this group's other ownership operations, so the row
      // read here is still the row deleted below; clearIfMatches additionally
      // covers invalidation by member.remove / role.set, which do not take the
      // lock.
      const pending = await ctx.ownershipLock.run(groupDid, async () => {
        const pending = await ctx.pendingTransfers.get(groupDb)
        if (!pending) {
          throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
        }
        if (callerDid !== pending.proposerDid && callerDid !== pending.recipientDid) {
          // Same 404 as "nothing pending": a distinct error would tell a
          // non-party that a transfer exists, which only its two parties may
          // know. True reason recorded in the audit log.
          await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.cancel', 'denied', {
            reason: 'caller is neither proposer nor proposed new owner',
          })
          throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
        }

        // Delete the exact proposal this caller was authorized against, not
        // whatever row exists now. The lock keeps propose out, but member.remove
        // and role.set invalidate a proposal without taking it, so the row read
        // above can still be gone — in which case there is nothing to cancel and
        // the caller gets the usual 404.
        const cancelled = await ctx.pendingTransfers.clearIfMatches(
          groupDb,
          pending.proposerDid,
          pending.recipientDid,
        )
        if (!cancelled) {
          throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
        }

        return pending
      })

      await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.cancel', 'permitted', {
        proposedOwner: pending.recipientDid,
        proposedBy: pending.proposerDid,
      })

      return jsonResponse({ groupDid, cancelled: true })
    },
  })
}
