import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { GroupDatabase } from '../db/schema.js'

/**
 * How long an unaccepted ownership-transfer proposal stays valid. Ownership
 * transfer is a deliberate, human-paced action (unlike the 2-minute auth
 * nonce), so the recipient gets a week to accept before the proposal lapses.
 */
export const PENDING_TRANSFER_TTL_SECONDS = 7 * 24 * 60 * 60

const EXPIRES_AT = sql<string>`datetime('now', '+${sql.raw(String(PENDING_TRANSFER_TTL_SECONDS))} seconds')`
const NOW = sql<string>`datetime('now')`

/** A live (non-expired) pending transfer. */
export interface PendingTransfer {
  proposerDid: string
  recipientDid: string
  createdAt: string
  expiresAt: string
}

/**
 * Per-group store for the single pending ownership transfer.
 *
 * Expiry is enforced lazily on read: `get` filters on `expires_at > now`, so an
 * expired row simply reads as "no pending transfer" and is overwritten by the
 * next `propose`. There is no background sweeper — the same pattern the nonce
 * cache uses, minus the periodic cleanup (a stale row is harmless and single).
 *
 * The table is pinned to a single row (`id = 1`, see migration 005), so
 * `propose` is an upsert: a new proposal replaces any existing one.
 */
export class PendingTransferStore {
  /** Read the live pending transfer, or null if none exists or it has expired. */
  async get(groupDb: Kysely<GroupDatabase>): Promise<PendingTransfer | null> {
    const row = await groupDb
      .selectFrom('pending_ownership_transfer')
      .select(['proposer_did', 'recipient_did', 'created_at', 'expires_at'])
      .where('expires_at', '>', NOW)
      .executeTakeFirst()
    if (!row) return null
    return {
      proposerDid: row.proposer_did,
      recipientDid: row.recipient_did,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  /**
   * Record a proposal, replacing any existing one (live or expired). Returns
   * the stored row (with the computed `created_at` / `expires_at`).
   */
  async propose(
    groupDb: Kysely<GroupDatabase>,
    proposerDid: string,
    recipientDid: string,
  ): Promise<PendingTransfer> {
    const row = await groupDb
      .insertInto('pending_ownership_transfer')
      .values({
        id: 1,
        proposer_did: proposerDid,
        recipient_did: recipientDid,
        expires_at: EXPIRES_AT,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          proposer_did: proposerDid,
          recipient_did: recipientDid,
          created_at: NOW,
          expires_at: EXPIRES_AT,
        }),
      )
      .returning(['proposer_did', 'recipient_did', 'created_at', 'expires_at'])
      .executeTakeFirstOrThrow()
    return {
      proposerDid: row.proposer_did,
      recipientDid: row.recipient_did,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  /** Remove any pending transfer (used by cancel, and on owner change). */
  async clear(groupDb: Kysely<GroupDatabase>): Promise<void> {
    await groupDb.deleteFrom('pending_ownership_transfer').execute()
  }

  /**
   * Remove the pending transfer only if it still matches the exact
   * `(proposerDid, recipientDid)` pair passed in. Returns true if a row was
   * deleted, false if none matched — meaning the proposal was replaced or cleared
   * by a concurrent propose/cancel/invalidation since the caller read it.
   *
   * Used by `accept`: an unconditional `clear()` there would delete whatever row
   * exists at delete time, which — if a concurrent `propose` replaced the pinned
   * row in the window between the accept handler reading it and clearing it —
   * would silently wipe the *new*, unrelated proposal. Scoping the delete to the
   * pair the accept actually acted on avoids that.
   */
  async clearIfMatches(
    groupDb: Kysely<GroupDatabase>,
    proposerDid: string,
    recipientDid: string,
  ): Promise<boolean> {
    const result = await groupDb
      .deleteFrom('pending_ownership_transfer')
      .where('proposer_did', '=', proposerDid)
      .where('recipient_did', '=', recipientDid)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0) > 0
  }

  /**
   * Remove the pending transfer if `did` is one of its parties (proposer or
   * recipient). Used by the membership-mutating endpoints (`member.remove`,
   * `role.set`) to invalidate a proposal whose owner or proposed owner has
   * changed underneath it — otherwise a dead proposal could be resurrected (e.g.
   * a removed-then-re-added recipient accepting a week-old transfer). A no-op
   * when there is no pending row or `did` is not a party. Ignores expiry: an
   * expired row is harmless but clearing it too is free.
   */
  async clearIfParty(groupDb: Kysely<GroupDatabase>, did: string): Promise<void> {
    await groupDb
      .deleteFrom('pending_ownership_transfer')
      .where((eb) => eb.or([eb('proposer_did', '=', did), eb('recipient_did', '=', did)]))
      .execute()
  }
}
