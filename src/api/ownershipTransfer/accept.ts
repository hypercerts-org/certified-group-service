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
 *
 * That liveness proof is why this is the one member-facing operation an API key
 * may not perform: a key is a bearer secret with no cryptographic tie to the
 * DID's signing key, so it keeps working after its creator can no longer sign as
 * that DID (lost PDS credentials, suspended or shut-down PDS, unrecoverable
 * self-hosted key, or a DID document rotated away by someone else). None of that
 * is visible to this service — the member row still reads `member` — so a key
 * could accept on behalf of an account nobody controls, leaving the group owned
 * by a DID that can never authenticate again. Only the operator-only
 * `admin.setOwner` break-glass could recover from that.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.ownershipTransfer.accept', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes, apiKeyRef } = auth.credentials
      const { repo } = (input?.body ?? {}) as { repo?: string }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      // Reject key auth up front, with a distinct error rather than the generic
      // scope denial `assertCanWithAudit` would raise. `ownershipTransfer.accept`
      // has no OPERATION_LXM entry, so the scope gate already denies keys; this
      // guard makes the refusal explicit and survives that mapping coming back.
      if (authKind === 'apiKey') {
        await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.accept', 'denied', {
          apiKeyRef,
          reason: 'ownership transfer must be accepted with a DID-authenticated request',
        })
        throw new XRPCError(
          403,
          'Ownership transfer must be accepted with a DID-authenticated request, not an API key',
          'ApiKeyNotPermitted',
        )
      }

      // Caller must be a member. The real gate — that the caller IS the proposed
      // owner — is below.
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
        // Scope the clear to the row we read, for the same reason the post-accept
        // clear below does: a concurrent propose may have replaced the pinned row
        // since, and an unconditional clear would silently wipe that unrelated
        // proposal.
        await ctx.pendingTransfers.clearIfMatches(
          groupDb,
          pending.proposerDid,
          pending.recipientDid,
        )
        throw new XRPCError(404, 'No pending ownership transfer', 'NoPendingTransfer')
      }

      ctx.memberIndex.transferOwner(
        ctx.groupDbs.getRaw(groupDid),
        groupDid,
        callerDid,
        previousOwner,
      )
      // Clear only the proposal we actually acted on. If a concurrent propose
      // replaced the pinned row between reading `pending` above and here, an
      // unconditional clear would silently wipe that new, unrelated proposal.
      const stillMatched = await ctx.pendingTransfers.clearIfMatches(
        groupDb,
        pending.proposerDid,
        pending.recipientDid,
      )
      if (!stillMatched) {
        // The transfer above still completed correctly; log so a superseded
        // proposal isn't lost without a trace.
        ctx.logger.warn(
          { groupDid },
          'pending ownership transfer changed before accept could clear it',
        )
      }

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
