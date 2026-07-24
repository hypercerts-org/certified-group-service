import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, sqliteToIso } from '../util.js'

/**
 * app.certified.group.ownershipTransfer.status — report a pending transfer.
 *
 * Scoped visibility (Kristofer's design, HYPER-313): a pending transfer is
 * disclosed only to the two parties — the current owner and the proposed new
 * owner. Other members are not told a transfer is in flight, so this is NOT
 * surfaced on member.list. When there is no live proposal, any member gets a
 * plain `pending: false` (nothing to hide); when there is one, a caller who is
 * neither party is refused rather than shown the details.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.ownershipTransfer.status', ctx, {
    handler: async ({ auth }) => {
      const { callerDid, groupDid, authKind, scopes, apiKeyRef } = auth.credentials
      if (!groupDid) {
        throw new XRPCError(400, 'Missing repo', 'InvalidRequest')
      }
      const groupDb = ctx.groupDbs.get(groupDid)

      // Any member may ask; the scope check is also enforced for an API key.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'ownershipTransfer.status', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      const pending = await ctx.pendingTransfers.get(groupDb)
      if (!pending) {
        return jsonResponse({ groupDid, pending: false })
      }

      // Details are disclosed only to the two parties. The proposer recorded on
      // the row is the owner at propose time; also allow whoever holds owner now.
      const currentOwner = await groupDb
        .selectFrom('group_members')
        .select('member_did')
        .where('role', '=', 'owner')
        .executeTakeFirst()
      const isParty =
        callerDid === pending.recipientDid ||
        callerDid === pending.proposerDid ||
        callerDid === currentOwner?.member_did
      if (!isParty) {
        throw new XRPCError(
          403,
          'You are not a party to this ownership transfer',
          'NotPartyToTransfer',
        )
      }

      return jsonResponse({
        groupDid,
        pending: true,
        proposedOwner: pending.recipientDid,
        proposedBy: pending.proposerDid,
        createdAt: sqliteToIso(pending.createdAt),
        expiresAt: sqliteToIso(pending.expiresAt),
      })
    },
  })
}
