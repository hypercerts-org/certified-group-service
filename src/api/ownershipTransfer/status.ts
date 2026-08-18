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
 * surfaced on member.list.
 *
 * A non-party gets exactly the same `pending: false` response as when nothing
 * is pending. Refusing them with a distinct error instead would itself be the
 * disclosure: a member could poll this endpoint and learn whether a transfer
 * is in flight from the status code alone, which is precisely what scoping the
 * visibility exists to prevent. The real reason is recorded in the audit log,
 * so operators can still see who probed and why they were refused.
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
        // Indistinguishable from "nothing pending" — see the note above.
        await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.status', 'denied', {
          reason: 'caller is not a party to this ownership transfer',
        })
        return jsonResponse({ groupDid, pending: false })
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
