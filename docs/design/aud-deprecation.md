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
- **Group-scoped query methods** (`member.list`, `audit.query`, …) carry the
  group **only** in `aud`. `member/list.ts:16` reads `groupDid` straight from
  `auth.credentials`; there is no request field, and clients that send one are
  rejected.

Two existing exceptions matter for framing:

- **`groups.membership.list` is not group-scoped.** It is already
  **service-level** — registered with `xrpcServiceAuth()`
  (`membership/list.ts:9`), so its `aud` is the **service DID** (verified
  correctly), it takes **no** group, and it returns the caller's memberships
  **across all groups**. It does not "carry the group only in `aud`"; it carries
  no group at all. It is the exception to the "query methods" framing above.
- **`group.register` / `group.import` already verify `aud === serviceDid`** via
  `registerServiceAuthMethod` → `xrpcServiceAuth()` (`register.ts:26`,
  `import.ts:59`). So the corrected-`aud` behaviour this doc specifies is **not
  net-new**: there is an existing, correct service-auth path. The implementation
  is best framed as **extending the existing service-auth check** to the
  group-scoped methods, not building a new one.

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

**Header injection mechanism (settled).** The auth verifier returns credentials
and does not set response headers — but `@atproto/xrpc-server` passes the
verifier `{ req, res, params }` and the handler context also carries `res`
(verified in `server.js`). The credential carries a `legacyAud: boolean`; a
handler wrapper in `registerAuthedMethod` reads it and sets the headers on
`res`. (Setting them in the verifier via its `res` is also possible, but the
wrapper keeps all authed methods uniform in one place.)

### 3. Removal trigger: undecided (out of scope for this PR)

This PR makes the legacy path deprecated-but-working. It does **not** remove it
and does **not** commit a removal date. Removal is deferred; the criteria to
revisit are documented in _Removal criteria_ below so the decision is informed
when it's taken. Consequently the `Sunset` header is omitted until a date is
set.

---

## Developer experience: the stock atproto SDK works unmodified

CGS's consumers are atproto app developers using standard SDKs (`@atproto/api`).
**Stellar DX is a primary goal**, and it is the decisive argument for this fix:

- The **current** `aud = groupDid` overload is **not expressible** through a
  stock SDK as a resource selector. `getServiceAuth` accepts only `aud` (the
  service), `exp`, and `lxm` (verified against the canonical lexicon); `aud` is
  the audience, not a resource. A developer wanting the current behaviour must
  understand CGS-specific semantics and rely on the group happening to equal the
  audience — fighting the SDK's model.
- The **fixed** shape is what a stock SDK already emits: `getServiceAuth({ aud:
serviceDid, lxm })` plus `repo` in the standard place for each method
  (`agent.com.atproto.repo.createRecord({ repo, … })`). No bespoke JWT, no
  SDK-bypassing fetch, no non-standard claims.

So the fix is not only correct per RFC 7519 — it is the version that an atproto
app dev can call **without thinking about CGS at all**, which is the bar.

## Service-DID resolution under proxying

The corrected `aud` is the **service DID**, a `did:web` derived from the service
URL (`config.serviceDid` = `did:web:${new URL(serviceUrl).hostname}`,
`src/config.ts`). A client building the JWT itself just constructs that string —
no lookup. But under **standard AT Protocol service proxying** the picture is
subtler, and the subtlety is worth recording because it is easy to re-derive
wrongly.

### The two paths mint `aud` differently

A proxying PDS sets the JWT `aud` to **the DID in the `atproto-proxy` header**
(`<did>#<fragment>`), then resolves that DID's document and forwards to its
service endpoint. So `aud` is decided by **which DID you proxy to**, not by any
CGS-side choice:

- **Legacy:** `withProxy('certified_group', groupDid)` → header `groupDid#certified_group`
  → PDS resolves the **group** DID (a `did:plc:*`, via the PLC directory), reads
  its `certified_group` entry, forwards, and mints `aud = groupDid`. This is the
  deprecated form, and it is what stock proxying produces today.
- **Migrated:** to get `aud = serviceDid` under proxying, the proxy target must be
  the **service** DID → header `serviceDid#…` → PDS resolves `did:web:<host>`. A
  `did:web` resolves by HTTP `GET https://<host>/.well-known/did.json` — so the
  migrated proxied path requires CGS to **serve that document**. (That is separate
  work; until it ships, full `aud = serviceDid` is reachable only on **direct**
  calls, where the client writes `aud` and the verifier string-compares it — no
  resolution, no served document needed.)

### The resolution chain is a redundant round-trip — and why it must be

Starting from nothing but a `groupDid`, a fully-migrated proxied call traverses:

```
groupDid
  → resolve group DID doc → certified_group entry → service endpoint URL   (A: discovery)
  → derive did:web:<host> from that URL                                    (B)
  → resolve service DID doc (/.well-known/did.json) → service entry → URL  (C: proxying)
  → forward
```

**Hop A's URL and hop C's URL are the same endpoint** — you resolve your way to
the service URL, derive the service DID from it, then resolve the service DID
straight back to the same URL. The redundancy is real, and it is **forced by a
layer seam**, not avoidable cleverness:

- **Hop A (discovery) is CGS-specific.** "Given a group, which service hosts it?"
  has exactly one on-protocol answer: the group DID document's `certified_group`
  entry. `register` / `import` return only `groupDid`, never the service DID, so
  this entry is the sole on-chain link. The entry is therefore needed on **both**
  paths — legacy uses it to route; migrated uses it to discover the service DID.
- **Hops B→C (proxying) are generic atproto.** The PDS's proxy step takes one
  input — the DID in the header — resolves _that_ document, forwards to _its_
  endpoint. It cannot consume hop A's already-known URL; standard proxying
  **always begins from the `aud` DID and re-resolves from scratch**. To obtain
  `aud = serviceDid` you must hand the PDS the service DID, which forces it to
  re-resolve the service document even though discovery already produced the URL.

The endpoint URL appears in two DID documents precisely because these two layers
do not share state.

**The round-trip is worst-case, not per-call.** Hop A only exists when the client
starts from a bare `groupDid` with no other knowledge. In practice an app is
configured with the service URL out-of-band (the integration guide's
`GROUP_SERVICE_DID` constant), so it derives the service DID directly and skips
hop A entirely. And direct calls skip hops B→C as well — they neither discover
nor resolve, they just assert `aud`. The full five-hop chain is the maximal case
(on-protocol discovery from nothing, under proxying), not the common one.

## Security: `repo` is unsigned (a deliberate reduction to atproto parity)

Moving the group selector from the signed `aud` claim to an **unsigned `repo`
request field** is a real change to the security posture, stated plainly:

- **Today**, the group lives in the JWT `aud`, which is **signed**. A token is
  cryptographically locked to one group; a caller cannot retarget it without
  re-minting (which needs their signing key).
- **After the fix**, the group lives in `repo`, which is **not** a JWT claim and
  is **not signed** (the service-auth JWT signs only `iss, aud, exp, lxm, jti` —
  verified in `@atproto/xrpc-server` `auth.js`; `getServiceAuth` exposes no
  resource/repo binding, and `createServiceJwt` has no claim passthrough). A
  caller can change `repo` freely within the token's life.

**This is a deliberate weakening**, not a free parity move: a compromised token's
reach widens from **one group** to **every group the caller is privileged in**,
for the token's lifetime. It is accepted because:

- **There is no convention-respecting alternative.** Binding `repo` to the
  signature would require a non-standard JWT — the exact deviation this issue
  removes, and the thing that breaks stock-SDK DX. "Keep `repo` signed" and
  "conform to atproto" are mutually exclusive; we chose conformance.
- **It is atproto-standard.** Every PDS treats `repo` as an unsigned request
  field and authorises it server-side. The fix lands CGS at the ecosystem's
  normal posture; the _current_ behaviour is the outlier (an extra lock atproto
  never gives `repo`).
- **No privilege escalation.** RBAC re-checks the signed `iss` against the
  target group's DB on every call, so a retargeted token only reaches groups the
  caller **already** holds a role in. The widening is in blast radius, not in
  reachable privilege.
- **Bounded window.** `exp ≤ 120s` (nonce-window cap) and single-use `jti`
  keep the exposure of any one token brief and non-replayable.

This mirrors — at lower severity — the blast-radius tradeoff
[`api-keys.md`](./api-keys.md) already accepts for long-lived keys. Scope
minimality (RBAC + short JWT life) is the mitigation in both.

---

## What changes

### Where `repo` lives: follow the stock SDK (the DX constraint)

The shape is dictated by **what an unmodified `@atproto/api` client emits**, not
by server convenience. A stock SDK call is:

```ts
const { token } = await agent.com.atproto.server.getServiceAuth({
  aud: cgsServiceDid, // the SERVICE — the only thing aud can mean
  lxm: 'com.atproto.repo.createRecord',
})
await agent.com.atproto.repo.createRecord(
  // repo in the BODY, via the typed call
  { repo: groupDid, collection, record },
  { headers: { Authorization: `Bearer ${token}` } },
)
```

Two facts follow, and they set the design:

- **Procedures carry `repo` in the request _body_** (`createRecord` is a
  body-input procedure). The stock SDK has no way to put `repo` in the
  querystring on a typed procedure call. So CGS **must** read procedure `repo`
  from the body, or the developer is forced to bypass the SDK — a DX failure.
- **The SDK mints `aud = serviceDid`.** It cannot place a group DID in `aud`;
  `aud` is the audience/service. So today's `aud = groupDid` overload is
  **unreachable through a stock SDK** without hand-crafting — the fix is what
  makes CGS callable from vanilla atproto tooling.

This forces a **split by method type** (which is exactly the atproto
convention — body for procedures, querystring for queries):

| method kind                                             | where `repo` is read                            | who resolves the group                             |
| ------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| query (`member.list`, `audit.query`)                    | querystring (`params.repo`)                     | the **verifier** (it receives `params`)            |
| procedure (`createRecord`, `putRecord`, `deleteRecord`) | request **body** (`input.body.repo`)            | the **handler** (the verifier cannot see the body) |
| `uploadBlob`                                            | querystring (raw body, no JSON `repo` possible) | the **handler**                                    |

**Why the verifier can't do it uniformly.** In `@atproto/xrpc-server` the auth
verifier runs **before** the body is parsed — it is handed `{ req, res, params }`
but not the input (verified in `server.js`: `paramsVerifier` → `authVerifier` →
`inputVerifier`). So a query's `repo` (in `params`) is visible to the verifier,
but a procedure's `repo` (in the body) is not. Rather than force `repo` into the
querystring on procedures (breaking stock-SDK calls), the group resolution for
procedures moves into the handler, which does see `input.body.repo`.

### `src/auth/verifier.ts` — `verify()` / `xrpcAuth()` (queries + legacy)

New precedence for the group, both forms accepted:

1. **New form (preferred):** `params.repo` present (queries). Then:
   - resolve it to a DID via `idResolver` if it's a handle; use as-is if already
     a DID (see _`repo` format and value handling_ above),
   - validate the resolved DID against the `groups` table (unchanged lookup),
   - require `aud === serviceDid` (verified the correct way).
2. **Legacy form (deprecated):** no `repo`. Fall back to today's behaviour —
   group from `payload.aud`, `verifyJwt(…, null, …)` skipping the audience check.
   Set `legacyAud = true` so the deprecation signal fires.
3. **Reject** if neither yields a registered group.

For **procedures**, the verifier authenticates the JWT and accepts either
`aud === serviceDid` (new) or `aud === <a registered group>` (legacy,
`legacyAud = true`); the **handler** then resolves `input.body.repo` to the
group DID. A shared helper (`resolveGroupFromRepo(repo)` in `src/api/util.ts`)
does the handle→DID resolution + `groups`-table validation once, reused by the
verifier (queries) and the procedure handlers, so the logic is not duplicated.

The returned credential gains a `legacyAud` flag, and `groupDid` becomes
optional (procedures fill it from the body):

```ts
export interface GroupAuthCredentials {
  callerDid: string
  groupDid?: string // set by the verifier for queries; by the handler for procedures
  legacyAud: boolean // true when the group came from aud, not an explicit repo
}
```

`assertTokenLifetime`, nonce/replay (`jti`), and signature checks are unchanged
for both forms — only the audience check and the group-source differ.

Both forms can be sent **together** during migration (a client adds `repo` but
still sets `aud=groupDid`). Precedence: **explicit `repo` wins** (new path, no
warning), regardless of `aud`. A client migrates by _adding_ `repo`; the warning
stops the moment it does. A client sending `repo` + `aud=serviceDid` is fully
migrated.

### Lexicons — add `repo` to query methods

Add the `repo` (`at-identifier`) **querystring** parameter to the lexicons for
the **group-scoped query** methods that lack it: `member.list`, `audit.query`.
The `repo.*` procedures already declare `repo` (in the body) — no change there.
The field is **optional during the deprecation window** (legacy callers omit
it); it becomes required only at the eventual hard cutover.

**Explicitly out of scope — these get _no_ `repo` field:**

- **`groups.membership.list`** stays service-level. Its result is inherently
  **cross-group**, keyed on the caller, not on any one group — adding `repo`
  would break that semantics. Do **not** sweep it into "add `repo` to the query
  methods."
- **`group.register` / `group.import`** are already service-level
  (`registerServiceAuthMethod`) and target no existing group, so they keep
  `aud === serviceDid` and gain no `repo`.

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

## Resolved during design

- **Header injection mechanism** — settled. The verifier receives `{ req, res,
params }` and the handler context carries `res` (verified in
  `@atproto/xrpc-server` `server.js`); a wrapper in `registerAuthedMethod` reads
  `credentials.legacyAud` and sets the headers. See _Header injection mechanism_
  above.
- **Where `repo` is read (procedures vs queries)** — settled by the DX
  constraint, not server convenience. Queries: querystring `params.repo` (read
  by the verifier). Procedures: request **body** `input.body.repo` (read by the
  handler, since the verifier runs before body parse). `uploadBlob`: querystring
  (raw body). See _Where `repo` lives: follow the stock SDK_.

## Open questions

- **Rate-limit window for the warn log.** Per caller-DID, per N minutes — pick N
  (5? 15?) at implementation; not load-bearing for the design.
