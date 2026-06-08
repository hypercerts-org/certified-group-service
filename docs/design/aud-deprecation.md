# Design: Fix the JWT `aud` overload (explicit group targeting + backwards-compatible deprecation)

Status: **Draft / proposal**

Tracking issues:

- [#27 — Fix inconsistent/incorrect use of JWT `aud` in CGS](https://github.com/hypercerts-org/certified-group-service/issues/27)
  (the work this doc designs) — Linear `HYPER-464`.
- [#26 — Generalised group-DID targeting + API-key framework](https://github.com/hypercerts-org/certified-group-service/issues/26)
  (`HYPER-463`, design in [`api-keys.md`](./api-keys.md)) — **depends on** this fix.
- [#12 — read-only API key for `member.list`](https://github.com/hypercerts-org/certified-group-service/issues/12)
  (the narrow request #26 generalises; blocked transitively by this).

This is the **design rationale** (the _why_). For the client-facing migration
how-to — the legacy-vs-new table, per-method `repo` placement, non-proxied vs
proxied calls, and detecting un-migrated calls — see
[`../aud-migration.md`](../aud-migration.md).

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

### The two ways a client calls CGS

Throughout this section, a client reaches CGS by one of two routes, referred to
below as the **direct** and **proxied** paths:

- **Direct call** — the client obtains a service-auth token from the user's PDS
  (via `com.atproto.server.getServiceAuth`) and sends the XRPC request to CGS
  itself, with that token in the `Authorization` header.
- **Service proxying** — the client sends the request to the user's PDS with an
  `atproto-proxy` header; the PDS mints the token and forwards the request to CGS
  on the client's behalf. This is the standard AT Protocol pattern.

In both cases the user's PDS signs the token; what differs (next) is who chooses
the `aud` claim.

### Deriving the service DID

The corrected `aud` is the **service DID**, a `did:web` whose host is the service's
own URL (`config.serviceDid` = `did:web:${new URL(serviceUrl).hostname}`,
`src/config.ts`). The server knows its own URL, so for it this is pure string
construction. A _client_, by contrast, must first discover the service URL from the
group's DID document (the `certified_group` entry) and only then derive the
`did:web` — the derivation is string-only, but it is preceded by that lookup.

### Direct and proxied calls set `aud` differently

On the **direct** path the client calls `getServiceAuth({ aud, lxm })` itself and
chooses `aud` outright (it sets the service DID). On the **proxied** path the
client never names `aud`: a proxying PDS sets the JWT `aud` to **the DID in the
`atproto-proxy` header**
(`<did>#<fragment>`), then resolves that DID's document and forwards to its
service endpoint. So `aud` is decided by **which DID you proxy to**, not by any
CGS-side choice:

- **Legacy:** `withProxy('certified_group', groupDid)` → header `groupDid#certified_group`
  → PDS resolves the **group** DID (a `did:plc:*`, via the PLC directory), reads
  its `certified_group` entry, forwards, and mints `aud = groupDid`. This is the
  deprecated form, and it is what stock proxying produces by default.
- **Migrated:** target the **service** DID →
  `withProxy('certified_group_service', serviceDid)` → header
  `serviceDid#certified_group_service` → PDS resolves `did:web:<host>`. A `did:web`
  resolves by HTTP `GET https://<host>/.well-known/did.json`, which CGS now serves
  (closing #29), so the PDS forwards and mints `aud = serviceDid`. The proxy id
  `certified_group_service` must match the service entry in the **service's** own
  document — distinct from the `certified_group` entry in a group's document (see
  _Two-fragment convention_ in `src/did-document.ts`).

What actually arrives in `aud`: the reference PDS **strips** the service-id
fragment when proxying, so today CGS receives `aud = did:web:<host>` (bare) — the
form the verifier has always accepted. The PDS is slated to stop stripping it
([AT Protocol XRPC spec — service proxying](https://atproto.com/specs/xrpc#service-proxying)),
after which `aud` would arrive as
`did:web:<host>#certified_group_service`; the verifier already accepts that exact
fragment (and rejects a foreign one) for forward-compatibility. Non-proxied calls
are unaffected either way — the client requests the bare service DID as `aud` (a
`getServiceAuth` `aud` is lexicon-typed `did`, which forbids a fragment) and the
verifier string-compares it; no resolution, no served document needed.

### The resolution chain is a redundant round-trip — and why it must be

Starting from nothing but a `groupDid`, a proxied call on the new form (proxying to
the service DID) traverses:

```text
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

**The round-trip is the intended path, not an inefficiency to route around.**
Resolving the group's DID document to discover its service (hop A) is how a client
is _supposed_ to find which service hosts a group — that on-protocol link is the
whole point of the chain, and it is needed whether the call is proxied (the PDS
resolves it to route) or non-proxied (the client resolves it to learn the service
URL). A client should not hardcode the service URL to skip it: doing so couples the
client to one deployment and breaks the moment a group is hosted elsewhere.

There is a real timing hazard in that resolution, however: right after
`group.register`, the group's DID document can still be cached as its **genesis
doc** — `register` adds the `certified_group` service entry in a _second_ PLC op
(`register.ts:114-132`), after `createAccount`, so a resolver that cached the doc
at account-creation has the entry-less version until its cache refreshes. A
resolution immediately after registration can therefore miss `certified_group` and
fail to locate the service. This affects **both** call routes (it is about
resolving the group doc, not about proxying per se), and it is why our first client
app currently hardcodes the service URL as a stopgap. Tracked as `HYPER-453`; a bug
to fix, not a pattern to bless.

What legitimately shortens the chain is the **call route**, not skipping
discovery: a non-proxied call doesn't proxy, so it skips hops B→C (it requests
`aud` directly without the PDS resolving the _service's_ document). The full
five-hop chain is the proxied-from-a-bare-`groupDid` case.

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

### Tampering / MitM: can an attacker swap `repo` and replay?

Because `repo` is unsigned, an on-path attacker who can modify the request _can_
change `?repo=groupA` to `?repo=groupB` without invalidating the signature. The
swap is contained by three independent gates, none of which the attacker can
forge:

- **RBAC re-check on the signed `iss`.** Authorization keys off `payload.iss`
  (signed) against the _swapped_ group's DB (`assertCanWithAudit(…, callerDid,
…)`). A swap therefore only reaches a group the **original caller already has a
  role in** — it cannot read a group the caller is not a member of, and cannot
  impersonate a different caller. The result the attacker obtains is one the
  caller was already entitled to fetch.
- **`lxm` binds the method.** The token is valid only for the method it was
  minted for (`member.list`), so a swap cannot repurpose it for another endpoint.
- **Single-use `jti` + short `exp`.** The token is consumed on first use
  (`nonceCache.checkAndStore` → "Replayed token"), so this is not a _passive
  replay_ attack: the attacker must actively intercept and **suppress** the
  genuine request to spend the token themselves, within `exp − iat ≤ 120s`.

Above all, modifying the querystring in flight means the attacker has already
broken TLS — at which point they can alter the request arbitrarily. The unsigned
`repo` adds blast radius **given a compromised transport**; it opens nothing
under normal HTTPS. Net: a `repo` swap can redirect a caller's own legitimate
query from one of their groups to another of their groups — no cross-caller,
cross-method, or cross-privilege escalation.

### Querystring visibility: `repo` is metadata in URLs and logs

For query methods (`member.list`, `audit.query`) and the raw/body-less methods,
`repo` rides the **querystring** — the atproto convention for queries, and what a
stock SDK emits. Unlike the auth token (always an `Authorization` header) and the
response (always the body), a querystring value commonly appears in server access
logs, reverse-proxy/CDN logs, and browser history. So an observer with log access
learns _which group's endpoint was queried_ — public metadata (a group DID is a
resolvable, public identity), **not** the caller (header) and **not** the members
(body).

Severity is low: the leaked value is a public identifier, and this is plain
atproto parity (`com.atproto.repo.*` queries already carry `repo` in the
querystring). It is nonetheless a real metadata exposure — for a group whose mere
existence is sensitive, its DID showing up in shared logs is a small disclosure.
A request body is not an option for queries (an atproto `query` has no `input`
schema; see _Where `repo` lives_ above), so the only avenue that keeps stock-SDK
DX is an HTTP header — whether that is workable is tracked as a follow-up
([#39](https://github.com/hypercerts-org/certified-group-service/issues/39)).

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
- **Queries carry `repo` in the _querystring_, and have no other option.** An
  atproto `query` lexicon declares a `parameters` block (→ querystring) and **no
  `input` schema** — there is structurally no body slot for a query, and the
  xrpc client/server route queries as GET with params in the querystring. (HTTP
  GET _can_ carry a body in the abstract, but `fetch` — what `@atproto/api` uses
  — forbids it, and RFC 9110 gives a GET body no defined semantics.) So a stock
  SDK consumer calling `member.list` / `audit.query` can supply `repo` **only**
  on the querystring; requiring a body would make the typed call impossible.
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

`repo` and `aud` are **not** independently switchable: a half-migrated mix is
rejected, not silently downgraded. When `repo` is present (a query), the verifier
**requires** `aud = serviceDid` — `repo` + `aud=groupDid` throws
`jwt audience does not match service did` (a hard `401`). So a client cannot "add
`repo` first and fix `aud` later"; it migrates a query by switching both at once.
Only `repo` + `aud=serviceDid` is the fully-migrated, warning-free state.

(An earlier draft of this design had "explicit `repo` wins regardless of `aud`,
no warning." That was **rejected** during implementation in favour of the hard
error above: a token whose signed `aud` still names the group is not a
service-targeted token, and accepting it would blur the very claim this fix
exists to correct. The verifier and its tests implement the hard error.)

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

A client migrates by **adding `repo: <groupDid>`** to each call **and** switching
`getServiceAuth?aud=<groupDid>` → `aud=<cgsServiceDid>`. For queries these are a
single coupled change: `repo` present with `aud=groupDid` is a hard `401` (see
above), so the client must do both together. For body-input procedures the body
`repo` is invisible at auth time, so `aud=<cgsServiceDid>` alone moves the call to
the new path (the handler then reads the body `repo`). Until migrated, a call
stays fully legacy (`aud=groupDid`, no `repo`) and receives the deprecation signal.

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

- **Verifier unit tests** (`tests/verifier.test.ts`): new `repo`-field path
  (DID and handle), `aud === serviceDid` accepted; legacy `aud`-as-group still
  accepted and flags `legacyAud`; `repo` present with `aud=groupDid` → hard
  `401 jwt audience does not match service did` (not a graceful downgrade);
  service-id fragment on `aud` accepted, a foreign fragment rejected;
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
