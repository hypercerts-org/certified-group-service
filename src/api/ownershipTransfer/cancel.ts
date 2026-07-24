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

      const pending = await ctx.pendingTransfers.get(groupDb)
      if (!pending) {
        throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
      }
      if (callerDid !== pending.proposerDid && callerDid !== pending.recipientDid) {
        await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.cancel', 'denied', {
          reason: 'caller is neither proposer nor proposed new owner',
        })
        throw new XRPCError(
          403,
          'You are not a party to this ownership transfer',
          'NotPartyToTransfer',
        )
      }

      await ctx.pendingTransfers.clear(groupDb)

      await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.cancel', 'permitted', {
        proposedOwner: pending.recipientDid,
        proposedBy: pending.proposerDid,
      })

      return jsonResponse({ groupDid, cancelled: true })
    },
  })
}
