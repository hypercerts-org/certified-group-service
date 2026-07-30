import { createHash } from 'node:crypto'
import { InvalidRequestError } from '@atproto/xrpc-server'

/**
 * Record authorship sidecars.
 *
 * In atproto, a repo has exactly one author: the repo's DID. Records written
 * through CGS are therefore all signed by the *group*, and which member
 * actually wrote a record is invisible to the network. CGS tracks that fact
 * internally (the per-group `group_record_authors` table), but an internal
 * SQLite table is neither public nor interoperable: it does not appear on the
 * firehose, is not part of CAR backups, and is lost if the group migrates to
 * another group service.
 *
 * The fix is to publish attribution *into the group's repo* as a sidecar
 * record (`app.certified.group.authorship`), written in the same commit as the
 * record it describes. The repo becomes the source of truth for authorship;
 * `group_record_authors` is demoted to a derived index used for fast RBAC
 * checks (and is rebuildable from the repo — see the rehydration pass in
 * `group.import`). See docs/design/record-authorship.md.
 */
export const AUTHORSHIP_COLLECTION = 'app.certified.group.authorship'

/** atproto record keys are capped at 512 characters. */
const MAX_RKEY_LENGTH = 512

/**
 * Value of an `app.certified.group.authorship` record. Declared as a type
 * alias (not an interface) so it structurally satisfies the
 * `{ [key: string]: unknown }` record value expected by the PDS client.
 */
export type AuthorshipRecord = {
  $type: typeof AUTHORSHIP_COLLECTION
  /** AT-URI of the record this attribution describes. */
  subject: string
  /** DID of the group member who created the subject record. */
  author: string
  /** API-key ref, when the record was written by a key-authenticated daemon. */
  via?: string
  createdAt: string
}

/**
 * Deterministic sidecar rkey for a subject record, so attribution is a direct
 * `com.atproto.repo.getRecord` away (no scan): `<collection>:<rkey>`. Both
 * NSIDs and rkeys draw from the rkey-legal charset (`[A-Za-z0-9._:~-]`), so
 * the composite is always a valid rkey — except for length, where we fall
 * back to the sha256 hex of the composite (64 chars, also rkey-legal).
 */
export function authorshipRkey(collection: string, rkey: string): string {
  const readable = `${collection}:${rkey}`
  if (readable.length <= MAX_RKEY_LENGTH) return readable
  return createHash('sha256').update(readable).digest('hex')
}

/** AT-URI of the authorship sidecar for a subject record. */
export function authorshipUri(groupDid: string, collection: string, rkey: string): string {
  return `at://${groupDid}/${AUTHORSHIP_COLLECTION}/${authorshipRkey(collection, rkey)}`
}

export function buildAuthorshipRecord(opts: {
  subject: string
  author: string
  via?: string
  createdAt?: string
}): AuthorshipRecord {
  return {
    $type: AUTHORSHIP_COLLECTION,
    subject: opts.subject,
    author: opts.author,
    ...(opts.via !== undefined ? { via: opts.via } : {}),
    createdAt: opts.createdAt ?? new Date().toISOString(),
  }
}

/**
 * The authorship collection is service-managed: only CGS itself writes it, as
 * a sidecar to the record it attributes. A caller writing (or deleting) it
 * directly could forge or erase attribution, so the record endpoints reject
 * it up front.
 */
export function assertNotAuthorshipCollection(collection: string): void {
  if (collection === AUTHORSHIP_COLLECTION) {
    throw new InvalidRequestError(
      `The ${AUTHORSHIP_COLLECTION} collection is service-managed and cannot be written directly`,
    )
  }
}
