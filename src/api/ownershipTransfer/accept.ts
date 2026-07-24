import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, resolveGroupDid } from '../util.js'

/**
 * app.certified.group.ownershipTransfer.accept — proposed owner accepts.
 *
 * This is the point where ownership actually moves. Only the DID named as the
 * proposed new owner may accept, and the authenticated request proves they still
 * control that DID — exactly the "is the new owner still viable" check that makes
 * the two-phase handshake safe. The previous owner is demoted to admin and the
 * caller promoted to owner atomically (MemberIndex.transferOwner, reused from the
 * admin setOwner path), then the pending proposal is cleared.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.ownershipTransfer.accept', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes, apiKeyRef } = auth.credentials
      const { repo } = (input?.body ?? {}) as { repo?: string }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      // Caller must be a member; the scope check is also enforced for an API key.
      // The real gate — that the caller IS the proposed owner — is below.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'ownershipTransfer.accept', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      const pending = await ctx.pendingTransfers.get(groupDb)
      if (!pending) {
        throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
      }
      if (pending.recipientDid !== callerDid) {
        // Do not reveal transfer details to a non-party; deny by identity.
        await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.accept', 'denied', {
          reason: 'caller is not the proposed new owner',
        })
        throw new XRPCError(403, 'You are not the proposed new owner', 'NotProposedOwner')
      }

      // Demote whoever holds owner now, not the proposer recorded on the row: the
      // current owner can differ from the proposer if ownership moved by another
      // route since propose. (Those routes clear the pending row, so in practice
      // the two agree — this stays robust if that ever changes.)
      const currentOwner = await groupDb
        .selectFrom('group_members')
        .select('member_did')
        .where('role', '=', 'owner')
        .executeTakeFirst()
      const previousOwner = currentOwner?.member_did ?? null

      // Defensive: a pending row should never name the current owner as recipient
      // (propose rejects AlreadyOwner, and the clear-on-owner-change invariant
      // keeps it so). Guard anyway, so a future change can't turn this into a
      // no-op that leaves a resolved-looking transfer, or worse.
      if (callerDid === previousOwner) {
        await ctx.pendingTransfers.clear(groupDb)
        throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
      }

      ctx.memberIndex.transferOwner(
        ctx.groupDbs.getRaw(groupDid),
        groupDid,
        callerDid,
        previousOwner,
      )
      await ctx.pendingTransfers.clear(groupDb)

      await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.accept', 'permitted', {
        newOwner: callerDid,
        previousOwner,
      })

      return jsonResponse({
        groupDid,
        owner: callerDid,
        ...(previousOwner ? { previousOwner } : {}),
        updatedAt: new Date().toISOString(),
      })
    },
  })
}
