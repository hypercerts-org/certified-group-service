import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import { ensureValidDid } from '@atproto/syntax'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  assertCanWithAudit,
  resolveGroupDid,
  sqliteToIso,
} from '../util.js'

/**
 * app.certified.group.ownershipTransfer.propose — owner proposes a new owner.
 *
 * Ownership does not move here: this records a pending proposal that the
 * proposed owner must accept. Requiring an explicit accept (which proves the
 * proposed owner still controls their DID) avoids bricking a group by handing
 * ownership to a DID whose keys/recovery are lost — the failure mode a unilateral
 * owner→newOwner change would risk. That safeguard lives entirely in `accept`.
 *
 * Requiring the proposed owner to already be a member is a separate, deliberate
 * policy choice — NOT part of that safeguard (membership is not proof of live
 * DID control; `accept` is). It keeps outsider onboarding on a single path
 * (`member.add`, or the operator-only `admin.setOwner` break-glass), and lets
 * `propose` fail fast rather than mint a proposal no one could ever accept.
 *
 * Only the owner may propose; a group holds at most one pending proposal, so
 * this replaces any existing one.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.ownershipTransfer.propose', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes, apiKeyRef } = auth.credentials
      // The lexicon marks `newOwner` required, so xrpc-server rejects a missing
      // body or field with a 400 before this runs. Guard anyway rather than
      // destructure a possibly-undefined body: it keeps the shape identical to
      // accept/cancel, and a lexicon edit can't turn this into a 500.
      const { repo, newOwner } = (input?.body ?? {}) as { repo?: string; newOwner?: string }
      if (typeof newOwner !== 'string' || newOwner.length === 0) {
        throw new XRPCError(400, 'Missing newOwner', 'InvalidRequest')
      }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const newOwnerDid = await resolveNewOwner(ctx, newOwner)

      const groupDb = ctx.groupDbs.get(groupDid)

      // Owner-only. The scope check is also enforced here for an API key.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'ownershipTransfer.propose', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      // The proposed owner must be an existing member, and not already the owner.
      const target = await groupDb
        .selectFrom('group_members')
        .select('role')
        .where('member_did', '=', newOwnerDid)
        .executeTakeFirst()
      if (!target) {
        throw new XRPCError(400, 'Proposed new owner is not a member of this group', 'NotAMember')
      }
      if (target.role === 'owner') {
        throw new XRPCError(400, 'Proposed new owner is already the owner', 'AlreadyOwner')
      }

      const pending = await ctx.pendingTransfers.propose(groupDb, callerDid, newOwnerDid)

      await ctx.audit.log(groupDb, callerDid, 'ownershipTransfer.propose', 'permitted', {
        proposedOwner: newOwnerDid,
        expiresAt: sqliteToIso(pending.expiresAt),
      })

      return jsonResponse({
        groupDid,
        proposedOwner: pending.recipientDid,
        proposedBy: pending.proposerDid,
        createdAt: sqliteToIso(pending.createdAt),
        expiresAt: sqliteToIso(pending.expiresAt),
      })
    },
  })
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
