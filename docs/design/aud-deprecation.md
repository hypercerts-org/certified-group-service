# Design: Fix the JWT `aud` overload (explicit group targeting + backwards-compatible deprecation)

Status: **Draft / proposal**

Tracking issues:

- [#27 — Fix inconsistent/incorrect use of JWT `aud` in CGS](https://github.com/hypercerts-org/certified-group-service/issues/27)
  (the work this doc designs) — Linear `HYPER-464`.
- [#26 — Generalised group-DID targeting + API-key framework](https://github.com/hypercerts-org/certified-group-service/issues/26)
  (`HYPER-463`, design in [`api-keys.md`](./api-keys.md)) — **depends on** this fix.
- [#12 — read-only API key for `member.list`](https://github.com/hypercerts-org/certified-group-service/issues/12)
  (the narrow request #26 generalises; blocked transitively by this).

This document designs the `aud` correctness fix that [`api-keys.md`](./api-keys.md)
names as a prerequisite but deliberately leaves out of its own scope (see that
doc's _Group targeting → The `aud` overload_ section and Open questions). It
resolves the two open questions `api-keys.md` parks for here:

- the **group-targeting field name & shape** (`api-keys.md` Open questions), and
- the **migration sequencing** between the legacy `aud` path and the new
  explicit-field path.

## Problem (recap)

The service reads the **group DID** from the JWT `aud` claim. That is a misuse
of `aud`. Per RFC 7519 and the AT Protocol reference (`verifyJwt` in
`@atproto/xrpc-server`), `aud` is the **DID of the service the token is
presented to** — it identifies the _recipient_, not the _resource_ acted on.

`src/auth/verifier.ts` calls `verifyJwt(jwt, null, nsid, …)`, passing `null` to
**skip** the audience check, then looks `payload.aud` up in the `groups` table
and treats it as the group selector (`verifier.ts:59-80`). The credential and
the resource selector are entangled, and differently per method:

- **`repo.*` procedures** (`createRecord`, `putRecord`, …) already carry the
  group in the request body as the standard `repo` field — _and_ redundantly in
  `aud`.
- **Query methods** (`member.list`, `audit.query`, …) carry the group **only**
  in `aud`. `member/list.ts:16` reads `groupDid` straight from
  `auth.credentials`; there is no request field, and clients that send one are
  rejected.

This blocks API keys (a key has no `aud`, so a query authenticated by a key has
nowhere to name its group) and is simply incorrect besides.

## Goal

Move group targeting to an **explicit request field**, let `aud` mean the
service's own DID, and do it **without breaking existing clients** — accept both
forms during a deprecation window, signal the legacy form clearly, and define a
migration path.

---

## Decisions

### 1. Targeting field: `repo` everywhere

The target group is named by the standard AT Protocol **`repo`** field
(`{ "type": "string", "format": "at-identifier" }`) on **every** authed method —
both the `repo.*` procedures (already present) and the query methods that lack
one today.

Rationale (this supersedes an earlier worry that `repo` reads oddly for
`member.list`):

- **The group DID genuinely _is_ a repo identifier.** A group is a real PDS
  account created by `group.register`; `member.list { repo: <groupDid> }` means
  "list the members of _this account's_ group." `repo` names _what_ you target,
  not _which storage_ answers — even though CGS answers from its own per-group
  SQLite rather than the PDS repo.
- **`repo` already means exactly this on the procedures.** Using a different
  field on queries would let a client target the same group two different ways
  depending on the verb — re-creating the per-method entanglement this issue
  exists to remove.
- **`com.atproto.repo.*` queries already take `repo`.** `listRecords`,
  `getRecord`, and `describeRepo` are query methods whose target repo is the
  `repo` at-identifier param. "`repo` on a query" is established convention.

Rejected alternative — a distinct `group` field for the custom query methods:
clearer in isolation, but introduces two targeting vocabularies, a divergence
risk, and a second thing to document and migrate. Not worth it.

#### `repo` format and value handling — the plan

`repo` is typed **`at-identifier`** (handle _or_ DID), matching the official
lexicons (`com.atproto.repo.createRecord` and `getRecord` both declare
`"format": "at-identifier"`, _"The handle or DID of the repo"_) and CGS's own
three procedures (`lexicons/app/certified/group/repo/*.json`).

**CGS honours both handles and DIDs** — the value is resolved to a DID before
use. A handle is **not** rejected (that would contradict the `at-identifier`
type). Concretely, the targeting path is:

1. Read `repo` from the request.
2. If it is a handle, resolve it to a DID via `ctx.idResolver`; if it is already
   a DID, use it as-is.
3. `sha256(DID)` locates the per-group DB; validate the DID against the `groups`
   table (`verifier.ts:71-80`, keyed on DID).

This **inverts the current source of truth**: `repo` stops being a redundant
cross-check of the `aud`-derived group and becomes the primary group selector.

**Consequence for the existing procedures.** `createRecord.ts:24-27` currently
does `if (input.repo !== groupDid) throw` — an exact string match against the
`aud`-derived DID. That check **must be removed**: once `repo` may be a handle
and is itself the selector, comparing it for string-equality against a DID is
wrong. It is replaced by the resolve-then-select path above; the resolved DID
_is_ `groupDid`. (Today the check happens to work only because every caller
sends `repo` = the same DID as `aud`.)

There is no DID-only iteration and no deferred-handle gap: handle resolution
ships in this PR, because anything less leaves the `at-identifier` type
advertising a capability the code refuses.

### 2. Deprecation signalling: warn log + RFC 8594 headers

When a request relies on the **legacy** behaviour (group taken from `aud`, no
`repo` field), the service:

- emits a **rate-limited server-side `warn` log** (`pino`, via `ctx.logger`)
  naming the caller DID, the method, and the group — so operators see legacy
  traffic, and
- attaches **[RFC 8594](https://www.rfc-editor.org/rfc/rfc8594) response
  headers** so clients see it programmatically:
  - `Deprecation: true` (the legacy targeting path is deprecated), and
  - `Sunset: <date>` _only once a removal date is chosen_ — omitted while
    removal is undecided (see below); the header is added when a date exists.
  - a `Link: <…>; rel="deprecation"` pointing at this doc / the issue, for a
    human-readable explanation.

Rationale: a log alone is invisible to the client developer who must act. RFC
8594 is the standard, machine-readable way to surface deprecation on the wire,
and is cheap to add. Rate-limiting the log prevents a chatty legacy client
from flooding logs (one warn per caller-DID per N minutes is enough to be
noticed without being noise).

**Implementation wrinkle (open, see below):** the `MethodAuthVerifier` returns
credentials and does **not** own the Express response, so headers cannot be set
from the verifier directly. The credential must carry a `legacyAud: boolean`
flag that a later stage (handler wrapper or route option) reads to set headers.

### 3. Removal trigger: undecided (out of scope for this PR)

This PR makes the legacy path deprecated-but-working. It does **not** remove it
and does **not** commit a removal date. Removal is deferred; the criteria to
revisit are documented in _Removal criteria_ below so the decision is informed
when it's taken. Consequently the `Sunset` header is omitted until a date is
set.

---

## What changes

The fix has one **chokepoint** (the auth verifier) plus **lexicon param
additions**. Because every handler already reads `groupDid` from
`auth.credentials` (e.g. `member/list.ts:16`), handler bodies are largely
untouched — they keep reading the credential; only _how the verifier populates
it_ changes.

### `src/auth/verifier.ts` — `verify()` / `xrpcAuth()`

New precedence for determining the group, both forms accepted:

1. **New form (preferred):** read the `repo` field from the request
   (body for procedures, query params for queries). If present:
   - resolve it to a DID via `ctx.idResolver` if it's a handle; use as-is if
     already a DID (see _`repo` format and value handling_ above),
   - validate the resolved DID against the `groups` table (unchanged lookup),
   - `aud` must equal the **service DID** (`this.serviceDid`) — verify it the
     correct way. Accept `aud === serviceDid`.
2. **Legacy form (deprecated):** no `repo` field present. Fall back to today's
   behaviour — group from `payload.aud`, `verifyJwt(…, null, …)` skipping the
   audience check. Set `legacyAud = true` on the result so the deprecation
   signal fires.
3. **Reject** if neither yields a registered group.

The returned credential gains a `legacyAud` flag:

```ts
export interface GroupAuthCredentials {
  callerDid: string
  groupDid: string
  legacyAud: boolean // true when the group came from aud, not the repo field
}
```

`assertTokenLifetime`, nonce/replay (`jti`), and signature checks are unchanged
for both forms — only the audience check and the group-source differ.

Note both forms can be sent **together** during migration (a client that adds
`repo` but still sets `aud=groupDid`). Precedence rule: **if `repo` is present,
it wins and is treated as the new path** (no deprecation warning), even if `aud`
is also the group DID — so a client migrates by _adding_ `repo`, and the warning
stops the moment they do, regardless of what they leave in `aud`. A client that
sets `repo` and a _correct_ `aud=serviceDid` is fully migrated.

### Lexicons — add `repo` to query methods

Add the `repo` (`at-identifier`) parameter to the lexicons for the query/custom
methods that lack it: `member.list`, `audit.query`, and any other authed method
whose group currently comes only from `aud`. The `repo.*` procedures already
declare `repo`, so no change there. The field is **optional in the lexicon
during the deprecation window** (legacy callers omit it); it becomes required
only at the eventual hard cutover.

### Deprecation headers

A small wrapper around the authed handler (or a `RouteOptions` hook —
_resolve at implementation, see open question_) inspects
`auth.credentials.legacyAud` and, when true:

- sets `Deprecation: true` and the `Link` deprecation header on the response,
- calls a rate-limited `ctx.logger.warn(...)`.

This wrapper lives next to `registerAuthedMethod` in `src/api/util.ts` so all
authed methods get it uniformly.

### Client side (out of this repo)

A client migrates by **adding `repo: <groupDid>`** to each call and switching
`getServiceAuth?aud=<groupDid>` → `aud=<cgsServiceDid>`. Until it does, it keeps
working on the legacy path and receives the deprecation signal. The two changes
are independent: adding `repo` silences the warning even before `aud` is
corrected.

---

## Migration sequencing (the second parked question)

Answering `api-keys.md`'s "confirm the key path can rely on the new field being
present before #27's hard cutover":

- **Now (this PR):** both paths accepted. New `repo` field is **optional**.
  Legacy `aud` works, warns, and carries `Deprecation: true`.
- **API-key work (#26) builds on this:** the key path _requires_ `repo` (a key
  has no `aud`). That requirement is **local to key-authenticated requests** —
  it does not force JWT callers off the legacy path. So #26 can ship while JWT
  legacy `aud` is still accepted; the two deprecation timelines are decoupled.
- **Later (not this PR):** once all clients send `repo` everywhere and traffic
  logs show no legacy `aud` use, choose a removal version, add `Sunset`, then in
  a subsequent release make `repo` required and delete the `aud`-as-group branch.

## Removal criteria (to revisit; not decided here)

Remove the legacy `aud`-as-group path when **all** hold:

1. all known clients send `repo` on every call (verified in their repos), and
2. server logs show **zero** legacy-`aud` requests over a sustained window from
   any client, and
3. a release is cut that (a) makes `repo` required in the lexicons, (b) deletes
   the `aud` fallback in `verifier.ts`, and (c) restores the correct
   `aud === serviceDid` enforcement unconditionally.

At that point set `Sunset` ahead of the removal release, then remove.

---

## Testing

- **Verifier unit tests** (`tests/auth.test.ts` style): new `repo`-field path
  (DID and handle), `aud === serviceDid` accepted; legacy `aud`-as-group still
  accepted and flags `legacyAud`; both-present → `repo` wins, no warning;
  neither → reject.
- **Per-method tests** that today rely on `aud`-derived `groupDid` (e.g.
  `tests/membership.test.ts`, `member.list`) get a new case sending `repo`
  explicitly. Default mock auth (`{ iss, aud }`, per `CLAUDE.md` Testing) keeps
  the legacy cases green, proving backwards compatibility.
- **Header/log assertion:** a legacy request sets `Deprecation: true` and emits
  one warn; a fully-migrated request sets neither.

## Open questions

- **Header injection mechanism.** The `MethodAuthVerifier` cannot set response
  headers (it returns credentials, not the response). Confirm the cleanest hook
  in `@atproto/xrpc-server`: a handler wrapper in `registerAuthedMethod`, a
  `RouteOptions` field, or post-handler middleware. Leaning: wrapper in
  `registerAuthedMethod` reading `credentials.legacyAud`.
- **Where the verifier reads `repo` for procedures vs queries.** Body for
  procedures, query params for queries — confirm both are available to the
  verifier at auth time given the `registerRawRoutes` / `express.json()`
  ordering (`CLAUDE.md` Architecture gotchas: uploadBlob is mounted before
  `express.json()`). `uploadBlob` is a `repo.*` procedure that already carries
  `repo`, but verify the raw-route path can read it pre-JSON-parse.
- **Rate-limit window for the warn log.** Per caller-DID, per N minutes — pick N
  (5? 15?) at implementation; not load-bearing for the design.
