# Public, interoperable record authorship

## Problem

In atproto, a repository has exactly one author: the repo's DID. Every record
written through CGS is committed and signed by the _group's_ identity, so
which member actually created a record is invisible to the network. Consumers
of a group's data (e.g. a frontend rendering a group's page) cannot show
"created by @member" without asking the group service.

CGS has always known the answer — every `createRecord`/`putRecord` writes a row
to the per-group `group_record_authors` table — but that table was:

- **Private.** It fed only the RBAC own-vs-any checks; no endpoint exposed it.
  (The audit log records the same information but is admin-only, mirroring the
  situation apps like Ma Earth have today: attribution exists but only in an
  internal, privileged log.)
- **Not interoperable.** An internal SQLite table does not appear on the
  firehose, is not part of CAR exports, cannot be indexed by an AppView, and
  is lost if the group migrates to a different group service. Relying on it as
  the source of truth couples authorship to one CGS deployment.

## Options considered

1. **Public query endpoint over the internal table** (e.g.
   `getRecordAuthor?uri=…`). Cheap, but attribution remains exactly as durable
   as one service's SQLite files, and every consumer must integrate with CGS
   specifically. Rejected as the primary mechanism.
2. **Stamp an author field into the record payload.** Travels with the record,
   but silently mutates user data, breaks closed lexicons under validation, and
   can be stripped or forged by any later edit. Rejected.
3. **Authorship sidecar records in the group's repo.** Chosen — see below.

## Design: `app.certified.group.authorship` sidecars

For every record created through CGS, the service writes a companion record
into the group's own repo:

```jsonc
// at://<group>/app.certified.group.authorship/<collection>:<rkey>
{
  "$type": "app.certified.group.authorship",
  "subject": "at://did:plc:group/app.bsky.feed.post/3abc",
  "author": "did:plc:member1",
  "via": "cgsk_…", // optional: API-key ref for daemon-written records
  "createdAt": "2026-07-07T12:00:00.000Z",
}
```

Because the sidecar lives in the signed repo, attribution is now:

- **Public** — any client can read it with plain `com.atproto.repo.getRecord`
  / `listRecords`; no CGS API involved.
- **Interoperable** — it flows over the firehose, survives in CAR exports,
  can be indexed by any AppView, and travels with the repo across PDS or
  group-service migrations. Another group service adopting the lexicon
  inherits the full attribution history.
- **Durable** — the internal `group_record_authors` table is demoted from
  source of truth to a **derived index** for fast RBAC lookups. `group.import`
  rebuilds it from the repo's sidecars (see Rehydration).

### Deterministic rkey

The sidecar's rkey is `<subject-collection>:<subject-rkey>` (e.g.
`app.bsky.feed.post:3abc`), so attribution for a known record is a direct
`getRecord` away — no scanning. Both NSIDs and rkeys draw from the rkey-legal
charset (`[A-Za-z0-9._:~-]`), so the composite is always valid; if it would
exceed the 512-char rkey cap, the sha256 hex of the composite is used instead
(64 chars, deterministic, same lookup procedure).

### Atomicity

`createRecord` (and `putRecord` creating a genuinely new record) writes the
subject record and its sidecar in a **single `com.atproto.repo.applyWrites`
commit**: there is no window in which a record exists unattributed, both land
on the firehose together, and it costs one PDS round-trip instead of two.

Consequences:

- CGS picks the rkey client-side (a TID via `@atproto/common-web`) when the
  caller does not supply one, because the sidecar embeds the subject's at-uri
  and must be built before the commit.
- **`validate` caveat:** `applyWrites`' `validate` flag is commit-wide, and
  the PDS does not know the `app.certified.group.authorship` lexicon, so
  `validate: true` would fail the entire commit. CGS passes `false` through
  and degrades `true` to the default (validate known lexicons — the caller's
  record still receives a `validationStatus`).

### Non-atomic edges (best-effort)

Two paths cannot be atomic and are deliberately best-effort — a failure is
logged, never surfaced, and repairable via the backfill:

- **Delete cleanup.** `deleteRecord` deletes the subject, then the sidecar in
  a separate call. `applyWrites` cannot batch them because a delete of a
  missing key fails the whole commit, and legacy records have no sidecar;
  plain `deleteRecord` is idempotent on the PDS, so this works for both. Worst
  case is an **orphaned sidecar**, which consumers must ignore once its
  subject no longer resolves.
- **Legacy-record edits.** `putRecord` on a record that exists on the PDS but
  has no tracked author (created before this feature, or imported) keeps the
  existing semantics — the edit attributes the record to the editor — and
  writes the sidecar after the update succeeds. (A brand-new record is
  detected with a `getRecord` probe and takes the atomic path.)

### The collection is service-managed

Direct `createRecord`/`putRecord`/`deleteRecord` calls targeting
`app.certified.group.authorship` are rejected with `InvalidRequest`: a member
who could write the collection directly could forge attribution; one who could
delete from it could erase attribution while the subject record lives on.
Sidecars are written and removed exclusively by CGS alongside their subjects.

### Immutability

Attribution records the **original creator** and is never rewritten: an edit
(even `putAnyRecord` by an admin) leaves the sidecar untouched, matching the
existing `onConflict(...).doNothing()` semantics of the internal table. Edit
history remains the audit log's job.

## Backfill: `app.certified.group.admin.backfillAuthorship`

Records created before this feature are attributed only in the internal table.
The operator-only endpoint (HTTP Basic, like `admin.setOwner`) publishes that
attribution into the repo:

1. Enumerate existing sidecars (`listRecords`, paginated) so the operation is
   idempotent.
2. For every `group_record_authors` row without a sidecar, write one —
   preserving the original author DID and creation timestamp — batched via
   `applyWrites` in chunks of 200 (the PDS per-commit cap).

Backfilled sidecars have no `via` (the key ref was not tracked historically).
The call is audit-logged as actor `admin`.

## Rehydration on `group.import`

After a successful import, CGS scans the repo for
`app.certified.group.authorship` records and seeds `group_record_authors` from
them (original author and creation time preserved; malformed values skipped).
This is what makes the internal table genuinely derived: a group migrating
from another CGS instance arrives with its attribution — and therefore its
own-record edit/delete permissions — intact. The pass is best-effort and never
fails the import.

## Trust model and limitations

- The sidecar is signed by the **group's** repo key: it is the group service
  attesting "member X wrote this", the same trust level as the audit log — not
  cryptographic proof by the member. Author-signed attribution would require
  members to sign record hashes with their own keys and is out of scope.
- **Privacy:** attribution makes member DIDs publicly linkable to content,
  which is more than the members-only `member.list` exposes today. Groups for
  whom this is a problem should not adopt the backfill; a per-group opt-out
  for sidecar writes is a possible follow-up if demanded.
- An external (non-CGS) write directly to the group's PDS bypasses attribution
  entirely — unchanged from before this feature.

## Consuming attribution (for app developers)

To show "created by" for `at://<group>/<collection>/<rkey>`:

```
GET <group-pds>/xrpc/com.atproto.repo.getRecord
    ?repo=<group>
    &collection=app.certified.group.authorship
    &rkey=<collection>:<rkey>
```

Resolve `author` to a handle/profile as usual. If the sidecar is missing, the
record predates attribution (ask the group's operator to run the backfill) or
was written outside CGS. Always verify the `subject` record still exists
before trusting an attribution record.
