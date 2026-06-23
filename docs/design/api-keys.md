# Design: API Keys for the Group Service

Status: **Implemented** (iteration 1 — read scopes `member.list` / `audit.query`, PDS-repo write scopes `repo:…?action=create|update|delete`, and `blob:` uploads)

Tracking issues:

- [#26 — Generalised group-DID targeting + API-key framework for all CGS XRPCs](https://github.com/hypercerts-org/certified-group-service/issues/26)
  (the work this doc designs)
- [#27 — Fix inconsistent/incorrect use of JWT `aud` in CGS](https://github.com/hypercerts-org/certified-group-service/issues/27)
  (the prerequisite `aud` correctness fix this design depends on)
- [#12 — read-only API key for getting list of group members](https://github.com/hypercerts-org/certified-group-service/issues/12)
  (the original narrow request that triggered the generalisation; #26 blocks it)

## Motivation

A platform that integrates with the group service often needs to keep its own
backend in sync with group membership held in AT Protocol — e.g. synchronising
a platform-side group membership list with the group service's view of who
belongs to a group. The original request ([#12](https://github.com/hypercerts-org/certified-group-service/issues/12))
was narrow: a read-only key for `member.list`. Combined with a separate need to
authenticate _write_ access from a backend (retroactively repairing broken
records), it became clear the key mechanism must be **generalised** rather than
bolted onto a single method — see _Group targeting_ below.

Today every authenticated call requires an **AT Protocol service-auth JWT**
(see `src/auth/verifier.ts`). That JWT is:

- short-lived — its lifetime must not exceed the nonce window
  (`NONCE_TTL_SECONDS` = 120s, `src/auth/nonce.ts`), and
- single-use — the `jti` is recorded in `nonce_cache` to prevent replay, and
- minted per request by a key the caller controls (their DID's signing key).

That model is correct for interactive, per-request access but a poor fit for a
**backend daemon** that wants to poll membership "indefinitely" without holding
the group owner's signing credentials and without minting a fresh signed JWT
every two minutes.

An **API key** is the missing primitive: a long-lived, owner-issued,
scope-limited bearer credential that a platform backend can store once and use
repeatedly.

## Goals

- An owner can mint a long-lived key scoped to a **single read-only operation**
  (`member.list`) — the concrete need that motivated this work.
- An owner can **list** and **revoke** keys they have issued.
- The scope model is **extensible** so further scopes (more read ops, then
  PDS-repo reads, then writes) can be added incrementally without redesign.
- **Reuse, don't reinvent, scope declaration.** Adopt the published
  `@atproto/oauth-scopes` package for parsing/matching scope strings rather than
  hand-rolling a permission grammar (see analysis below).
- Key auth coexists with the existing JWT auth path **without weakening it** —
  no changes to nonce/replay handling for JWT callers.
- **Group targeting is auth-mode-independent.** Any XRPC names its target group
  the same way regardless of whether the caller authenticates with a JWT or an
  API key — the group is a _request_ property, not an auth-token property (see
  _Group targeting_). This is the part that generalises #12 and is tracked by
  [#26](https://github.com/hypercerts-org/certified-group-service/issues/26).

## Non-goals (this iteration)

- Returning a key from `app.certified.group.register` output (issue comment 1).
  Deprioritised by the issue author because it does not help groups that
  already exist; captured below as a future option only.
- Per-key rate limiting, usage analytics, automatic expiry/rotation. Hooks are
  noted but not specified here.

---

## Group targeting (the part that generalises #12)

API keys cannot be designed in isolation, because of _how the service currently
learns which group a request targets_. Today that is inconsistent, and one of
the two ways doesn't work for API keys at all.

### How the group is named today

- **`repo.*` procedures** (`createRecord`, `putRecord`, …) carry the group in
  the **request body** as the standard AT Protocol `repo` field
  (`{ "format": "at-identifier" }`) — _and_ additionally set the JWT `aud` to
  the group DID.
- **`member.list` and other queries** carry the group **only** in the JWT
  `aud` claim. There is no group request parameter; passing one is actively
  rejected (`"Invalid query parameter: groupDid"`, observed in a client
  integration's direct CGS client). The group is implied entirely by the token.

So the resource selector (which group) and the auth credential (the JWT) are
entangled differently per method.

### Why this blocks API keys

An API key is **not** a JWT — it has no `aud` claim. A request that learns its
group _only_ from `aud` therefore has **nowhere to name the group** when
authenticated by a key. The very method #12 asks for (`member.list`) is exactly
this case. So before keys can work generally, group targeting must be moved out
of the auth token.

### The `aud` overload — and why it's wrong (issue #27)

The group service reads the group DID from the JWT `aud` claim. That is a
misuse of `aud`. Per RFC 7519 and the AT Protocol reference implementation
(`verifyJwt` in `@atproto/xrpc-server`), `aud` is the **DID of the service the
token is presented to** — the audience identifies the _recipient_, not the
_resource_ being acted on. The reference library enforces `payload.aud ===
ownDid` unless you pass `null` to skip it; this service passes `null`
(`src/auth/verifier.ts`) precisely so it can repurpose `aud` as a group
selector. Existing clients mirror this by requesting
`com.atproto.server.getServiceAuth?aud=<groupDid>`.

Fixing that overload is a prerequisite, tracked separately as
[#27](https://github.com/hypercerts-org/certified-group-service/issues/27), and
must be **backwards-compatible**: accept the new explicit-resource form _and_
the legacy `aud=groupDid` form, deprecate the latter with clear signalling, and
provide a migration path before any hard removal.

### Decision: the group is a request-level resource identifier

Treat the target group as a **resource**, named explicitly and consistently in
the request — the standard AT Protocol way, i.e. the **`repo` field** (or an
equivalent explicit field for query methods that currently lack one). Then:

- **Both auth modes share one targeting path.** JWT and API-key requests both
  read the group from the request; `aud` (JWT only) reverts to its correct
  meaning — the group service's own DID.
- **No reverse lookup, no key-embedded DID, no global key index.** This is the
  key simplification for the rest of this doc. The group DID arrives in the
  request, is forward-hashed (`sha256(groupDid)`) to locate the per-group DB,
  and the API key is then checked against _that_ DB. The credential never has to
  reveal which group it belongs to — exactly the username/password model: the
  DID is the username (supplied, not secret), the key is the password (verified
  against the named account). The "reverse-mapping problem" the per-group hash
  filename creates (`hash → DID`) is never exercised, because targeting only
  ever goes `DID → hash`.
- **`member.list` et al. gain an explicit group field** as part of #26, lifting
  the current "Invalid query parameter" rejection for the new path.

The rest of this document assumes this model.

---

## Can we reuse the AT Protocol permission spec?

Short answer: **reuse the scope _vocabulary_ (and an existing npm package that
implements it), but not the OAuth _grant mechanism_.**

Two separable things are bundled in the spec:

1. **How permissions are _declared and matched_** — the `repo:`/`rpc:`/`blob:`/
   `account:`/`identity:` scope-string grammar
   (e.g. `repo:app.example.profile?action=delete`,
   `rpc?lxm=*&aud=did:web:api.example.com%23svc_appview`).
2. **How permissions are _granted_** — by an OAuth Authorization Server (the
   PDS) during an OAuth flow, riding inside short-lived OAuth access tokens.

The spec is **exclusively about OAuth client permissions** for grant purposes:
it defines **no long-lived API key** and **no mechanism for a third-party
service to issue and validate its own credential**. The group service is not
the user's PDS / authorization server, so we cannot mint AT-Protocol-spec
tokens — we need our own credential (the rest of this doc).

But the _declaration/matching_ half (point 1) is exactly the wheel we don't
want to reinvent, and **it already exists as a standalone, published npm
package**:

> **[`@atproto/oauth-scopes`](https://www.npmjs.com/package/@atproto/oauth-scopes)**
> (v0.5.0, MIT, not marked private) —
> _"A library for manipulating and validating ATproto OAuth scopes in
> TypeScript."_
> Source: `bluesky-social/atproto`, `packages/oauth/oauth-scopes/`.

It exports exactly the primitives we need, decoupled from any OAuth flow:

- `RpcPermission`, `RepoPermission`, `BlobPermission`, `AccountPermission`,
  `IdentityPermission` — one class per resource type, each with:
  - `static fromString(scope)` — parse a scope string (returns `null` if
    invalid),
  - `matches({ lxm, aud, ... })` — does this permission cover a given request,
  - `static scopeNeededFor({ lxm, aud })` — compute the scope string an op
    requires,
  - `toString()`.
- `ScopesSet extends Set<string>` — `ScopesSet.fromString(json)` plus
  `matches(...)` to test whether a _set_ of granted scopes covers a request.
- `IncludeScope` — the "permission set" (named bundle) primitive, for later.

This means we do **not** hand-roll a scope parser, matcher, or grammar. We
store granted scope strings on the key, load them with `ScopesSet.fromString`,
and at request time check coverage with the same matcher Bluesky uses.

### How we'd wire it in

Map each group-service operation to the scope string it requires using the
package's own helpers, instead of our own ad-hoc strings:

```ts
import { ScopesSet, RpcPermission } from '@atproto/oauth-scopes'

// At request time, given an api-key credential:
// `ScopesSet.fromString` takes a SPACE-SEPARATED scope string, not JSON —
// join the stored array with a space.
const granted = ScopesSet.fromString(key.scopes.join(' '))
// `matches` takes TWO args: the resource kind, then the match options.
if (!granted.matches('rpc', { lxm: 'app.certified.group.member.list', aud: serviceAud })) {
  throw new Forbidden()
}
```

> **Two API facts verified against `@atproto/oauth-scopes@0.5.0`** (the design's
> earlier pseudo-code had both wrong — see [[reference_atproto-oauth-scopes-api]]):
>
> - **`ScopesSet.matches(resource, options)` is two-arg** — `matches('rpc', {
lxm, aud })`, not `matches({ lxm, aud })`. The single-arg form silently
>   returns `false` (treats the object as the `resource` key). `has(needed)`
>   also won't match reliably because the stored string is normalised
>   (`#` → `%23`); always go through `matches`.
> - **The `aud` must be a service-ref DID with a fragment**
>   (`did:web:host#fragment`), not a bare DID. `isAtprotoDidRefAbsolute`
>   **rejects bare `did:plc:*` and fragment-less `did:web`** outright — only
>   `did:web:host#frag` passes. CGS must therefore expose its service DID as a
>   `did:web:…#<service-id>` ref for `rpc:` scopes to validate. This needs
>   confirming against the deployed service DID — see Open questions.

Group-service XRPC methods are a natural fit for **`rpc:` scopes** (they are
RPC calls to our service, audience = our service DID). When we later proxy
reads/writes to the group's PDS repo, those map onto **`repo:` scopes** —
already implemented by `RepoPermission`.

What we still **do not** reuse: the OAuth grant flow, AS token issuance, and
the dynamic permission-set _Lexicon resolution_ (we can use `IncludeScope`
locally without running an authorization server).

### Caveats to confirm before depending on it

- **Version churn / pre-1.0.** `@atproto/oauth-scopes` is `0.x` (`0.5.0`); the
  spec itself is recent. Pin the version and budget for API drift, as we
  already do with other `@atproto/*` deps.
- **Coupling.** Verify it pulls in no heavy OAuth-server transitive deps (it is
  published separately from `oauth-provider`, which is the good sign). Confirm
  at add-time with `pnpm why`.
- **Semantic fit.** Our `member`/`admin`/`owner` RBAC is orthogonal to scopes;
  the package handles _scope_ coverage only. We still layer scopes **on top of**
  the existing role check (see Authorization below) — the package does not
  replace `src/rbac/`.

---

## Rejected alternative: UCANs

[UCAN](https://ucan.xyz/) (User Controlled Authorization Network) is a
capability-based, cryptographically-signed bearer token: verifiable **without
contacting the issuer**, with built-in **delegation** (chain tokens) and
**attenuation** (each link narrows scope). It targets decentralized,
offline-capable, peer-to-peer authorization where no central authority holds an
access-control list.

It was considered and **rejected** for this feature. The reasons:

- **It optimises for problems we don't have.** UCAN's value is offline /
  no-central verification and cross-service delegation chains. Here the group
  service **is** the central authority, **owns** the per-group DB, and is online
  for every request anyway — so none of those benefits apply, while the
  complexity does.
- **It reintroduces the credential we are trying to avoid holding.** A UCAN is
  signed by the holder's key, so for a platform backend to mint or refresh
  UCANs on the owner's behalf it must hold the **owner's signing key material**
  — exactly the situation the service-auth JWT path already imposes and the one
  this API-key design exists to escape. A revocable opaque key stored in the
  platform backend is _less_ sensitive than the owner's signing key, not more.
- **Revocation is UCAN's weak spot.** Self-verifying tokens need a
  blacklist/CRL the verifier consults to revoke early — i.e. a central lookup,
  which negates the offline benefit and is precisely what our `revoked_at`
  column already does, without the delegation-chain machinery.
- **It runs against where AT Protocol itself landed.** atproto's service-auth
  JWT (DID issuer + `aud` + `exp` + `lxm` method-binding + `jti` nonce) is a
  deliberately simplified, UCAN-_adjacent_ scheme rather than full UCAN, and the
  ecosystem's permission-declaration story is OAuth + `@atproto/oauth-scopes`
  (which this design reuses). Adopting UCAN would diverge from the rest of the
  stack for no gain here.

| factor                            | UCAN wins when… | our situation                        |
| --------------------------------- | --------------- | ------------------------------------ |
| offline / no-central verification | ✓               | verifier _is_ the central DB — moot  |
| cross-service delegation chains   | ✓               | one platform → one service, no chain |
| no server-side credential state   | ✓               | we _want_ a revocable server record  |
| short-lived, frequently re-minted | ✓               | we _want_ long-lived, store-once     |

**When to revisit:** if a future requirement appears for genuine _cross-service
delegation_ — the group service acting on a user's behalf toward some third
service, in a chain — UCAN becomes worth re-evaluating. It is not iteration 1's
problem.

---

## Design overview

```text
Platform backend                 Group Service                  Per-group DB
     |                                |                              |
     |  (one-time, owner JWT auth)    |                              |
     |  keys.create {scopes:[...]}    |                              |
     |------------------------------->|  generate key                |
     |                                |  hash, store ----------------|--> group_api_keys
     |  <-- plaintext key (once) -----|                              |
     |                                |                              |
     |  (repeated, long-lived)        |                              |
     |  X-API-Key: cgsk_<secret>      |                              |
     |  member.list { repo: <did> }-->|  group DID from request      |
     |                                |  sha256(did) → open group DB |
     |                                |  hash secret, compare -------|--> group_api_keys
     |                                |  check scope covers op       |
     |                                |  audit log                   |
     |  <-- members[] ----------------|                              |
```

Three new pieces:

1. **Request-level group targeting** (`repo`/explicit field) shared by both auth
   modes — see _Group targeting_. The DID comes from the request, never the key.
2. A **key-auth branch** in the request path, parallel to the JWT branch.
3. A **`group_api_keys` table** per group, plus three owner-only management
   methods. No new global table — group isolation stays fully intact.

---

## Key format

```text
cgsk_<keyRef>.<secret>
```

- `cgsk` — fixed prefix (Certified Group Service Key), so leaked keys are
  recognisable and can be scanned for (cf. GitHub `ghp_`).
- `<keyRef>` — short, non-secret per-key id (the `group_api_keys` primary key).
  It identifies _which key_ within the already-located group DB, so `keys.list`
  and `keys.delete` have a stable handle, and so the hash compare targets one
  row rather than scanning. It does **not** encode the group — the group is
  named by the request (see _Group targeting_).
- `<secret>` — high-entropy random (≥ 256 bits, base32/base64url). Only the
  **hash** is stored server-side; the plaintext is returned **once** at
  creation and never retrievable again.

The key carries **no group identifier** and there is **no global key index**:
the group DID arrives in the request, locates the per-group DB by forward hash,
and the key is verified there — the username/password model from _Group
targeting_.

Validation: the request's group DID → `sha256(did)` → open that group's DB →
look up `<keyRef>` in `group_api_keys` → hash `<secret>` (SHA-256, constant-time
compare) against the stored `key_hash`. A mismatched DID and key simply fail to
find a matching row — no oracle distinguishing "wrong group" from "wrong key".

---

## Storage

Decision: a **single per-group SQLite table**. Keys are inherently
group-scoped (owner-issued per group) and belong with that group's isolated
data. Because the group is named by the request and located by forward hash,
**no global key table is needed** — per-group isolation is preserved end to end.

### Per-group DB — `group_api_keys` (new)

| column         | type | notes                                                          |
| -------------- | ---- | -------------------------------------------------------------- |
| `key_ref`      | text | PK; the non-secret `<keyRef>` in the key string                |
| `key_hash`     | text | SHA-256 of the secret; never the plaintext                     |
| `name`         | text | owner-supplied label (e.g. "platform backend")                 |
| `scopes`       | text | JSON array of scope strings                                    |
| `created_by`   | text | owner DID that minted the key                                  |
| `created_at`   | text | `defaultTo(sql\`(datetime('now'))\`)`, per existing convention |
| `last_used_at` | text | nullable; updated on use (best-effort)                         |
| `revoked_at`   | text | nullable; set by `keys.delete` (soft delete)                   |

All columns are Kysely `text` — timestamps are stored as SQLite `text` via
`datetime('now')`, matching every existing migration (`created_at`, `added_at`,
`expires_at` in `src/db/migrations/`), not a `DATETIME` affinity type.

Notes:

- One new migration file: `src/db/migrations/group/00X_api_keys.ts` (Kysely
  migrator, per `src/db/migrate.ts`). No global migration.
- Soft-delete (`revoked_at`) over hard-delete so audit references stay valid;
  `keys.list` filters it out by default.
- No cross-group cleanup concern: deleting a group drops its DB, and the keys
  go with it. There is no global structure mapping keys to groups.

---

## Authentication: a second branch

Decision: keys travel in a **separate header**, `X-API-Key`, not in
`Authorization: Bearer`. This keeps the JWT path — including all nonce/replay
logic — completely untouched, and avoids sniffing-ambiguity between an opaque
key and a JWT.

Proposed shape in `AuthVerifier` (`src/auth/verifier.ts`):

```ts
// New credential variant
export interface ApiKeyCredentials {
  callerDid: string // the issuing owner's DID (see Open questions); key id travels in audit detail
  groupDid: string
  scopes: string[] // scope strings granted to this key
  authKind: 'apiKey'
}
```

`xrpcAuth()` (or a new combined verifier) branches:

1. If `X-API-Key` present → **key path**:
   - read the **group DID from the request** (the `repo`/explicit field — see
     _Group targeting_); reject if absent or not a registered group
   - `sha256(groupDid)` → open that group's DB
   - parse `<keyRef>` from the key, load its `group_api_keys` row, reject if
     missing or `revoked_at` set
   - constant-time compare SHA-256(secret) vs `key_hash`
   - **no nonce, no 2-minute lifetime** — keys are long-lived by design
   - touch `last_used_at` (best-effort, non-blocking)
   - return `ApiKeyCredentials`
2. Else fall through to existing JWT `verify()` unchanged.

Note the key path needs the group DID _before_ it can authenticate, so the
group-targeting field is read at the auth layer, not just in the handler. This
is the same value the (fixed, #27) JWT path will read from the request rather
than from `aud`.

Security properties of the key path vs the JWT path:

| property        | JWT path            | API-key path             |
| --------------- | ------------------- | ------------------------ |
| lifetime        | ≤ 120s              | long-lived until revoked |
| replay defence  | nonce (`jti`)       | none — bearer secret     |
| proof of holder | DID signing key sig | possession of the secret |
| blast radius    | one request         | every op in key's scope  |

Because a key has a larger blast radius, **scope minimality is the primary
mitigation** — hence read-only, single-op scopes first.

---

## Authorization: scopes vs roles

Scopes and roles are **orthogonal**: scopes (from `@atproto/oauth-scopes`)
describe _what a key may invoke_; RBAC roles (`src/rbac/`) describe _what a
principal is allowed to do_. Both checks must pass for a key-authenticated
request:

1. **Scope check (new, delegated to `@atproto/oauth-scopes`):** does the key's
   granted scope set cover the requested operation? Computed, not hand-rolled —
   `RpcPermission.scopeNeededFor({ lxm, aud })` gives the required scope and
   `ScopesSet.matches(...)` tests coverage (incl. wildcards). The package owns
   the grammar and matching semantics.
2. **Role check (existing RBAC, unchanged):** the key acts on behalf of its
   issuing owner. A key can never exceed the permissions of the role that
   minted it, and is **further** narrowed by its scopes. First iteration's only
   scope is a `member`-level read, so this is trivially satisfied, but the gate
   must enforce `effective = scopes ∩ role-perms`.

Implementation: extend the gate so `assertCanWithAudit` (`src/api/util.ts`)
understands a key principal — for an `apiKey` credential it runs the
`@atproto/oauth-scopes` coverage check **and** the role-derived `canPerform`
(`src/rbac/permissions.ts`), and logs the key id in the audit `detail`. Our
`Operation` union stays as the internal RBAC vocabulary; scope strings are the
_external_ vocabulary, mapped to operations by a small lookup table.

Scope registry. The `rpc:` strings are shown abbreviated; the real `rpc:` scope
carries the audience param (`aud=<serviceDid>`) that `scopeNeededFor` emits, and
is bound to this service for the client (clients pass the friendly form).
`repo:`/`blob:` scopes carry no `aud` and are stored verbatim:

| scope                                 | covers operation              | iteration |
| ------------------------------------- | ----------------------------- | --------- |
| `rpc:app.certified.group.member.list` | `member.list` (read)          | 1 (now)   |
| `rpc:app.certified.group.audit.query` | `audit.query` (read)          | 1 (now)   |
| `repo:<collection>?action=create`     | `createRecord`                | 1 (now)   |
| `repo:<collection>?action=update`     | `putRecord` (own/any/profile) | 1 (now)   |
| `repo:<collection>?action=delete`     | `deleteRecord` (own/any)      | 1 (now)   |
| `blob:<accept>` (e.g. `blob:image/*`) | `uploadBlob`                  | 1 (now)   |

For `repo:` ops, the scope says _which collection + action_; the RBAC role check
underneath still decides _whose_ records (own vs any) — `repo:` scopes have no
ownership axis, so a member-issued key remains own-only. See _Authorization_.

Audit logging already records `actor_did`, `action`, `result`
(`group_audit_log`). Add a `detail.apiKeyRef` so key-driven actions are
attributable to a specific key, not just to the owner DID.

---

## New lexicons / XRPC methods

All three are **owner-only** and authenticated with the **existing JWT path**
(an owner managing their keys is an interactive, high-trust action — keys
should not be able to mint or revoke other keys in iteration 1).

### `app.certified.group.keys.create` (procedure)

- input: `name` (string), `scopes` (string[])
- output: `keyRef`, `key` (full plaintext — **only time it is returned**),
  `scopes`, `createdAt`
- errors: `InvalidScope`, `Forbidden`

### `app.certified.group.keys.list` (query)

- params: `limit`, `cursor` (mirror `member.list` pagination)
- output: `keys[]` of `{ keyRef, name, scopes, createdBy, createdAt,
lastUsedAt }` — **never** the secret or hash
- excludes revoked keys unless an `includeRevoked` param is set

### `app.certified.group.keys.delete` (procedure)

- input: `keyRef`
- effect: sets `revoked_at`; key rejected on next use
- errors: `KeyNotFound`, `Forbidden`

Wiring follows the existing pattern: lexicon JSON under
`lexicons/app/certified/group/keys/`, handlers under `src/api/keys/`,
registered via `registerAuthedMethod` in `src/api/index.ts`.

---

## Worked example: platform membership sync

1. Group owner logs in to the platform; platform mints an owner service-auth
   JWT as today.
2. Platform calls `keys.create { name: "platform backend sync", scopes:
["rpc:app.certified.group.member.list"] }` → receives `cgsk_…` once.
3. Platform stores the key in its backend secret store. (Storing a key good
   only for one read-only op is far less sensitive than full read/write.)
4. Backend polls `member.list { repo: <groupDid> }` indefinitely with
   `X-API-Key: cgsk_…` — the group named in the request, no JWT, no 2-minute
   refresh, no owner credentials held.
5. If the key leaks, owner calls `keys.delete`; the key dies on next use.

---

## Open questions

- **Synthetic `callerDid` for key principals.** Audit/RBAC code assumes a DID
  actor. Use the issuing owner's DID (attribute key actions to the owner, plus
  `detail.apiKeyRef`), or a synthetic `did:cgs:key:<ref>`? Owner-DID is simpler
  and keeps RBAC unchanged; synthetic is cleaner for attribution. Leaning
  owner-DID + `apiKeyRef`.
- **`last_used_at` write cost.** Touching it per request adds a write to a
  read-only path. Make it best-effort / sampled, or drop it from iteration 1.
- **Key vs owner role drift.** If the issuing owner is later demoted/removed,
  should their keys keep working? Proposal: a key is invalid if its issuer no
  longer holds the role required by the key's scopes (re-checked at use time).
- **Rotation.** No rotation primitive in iteration 1; revoke + create is the
  story. Add `keys.rotate` later if needed.
- **Group-targeting field name & shape (part of #26).** Reuse the AT Protocol
  `repo` field everywhere, or introduce a distinct field (e.g. `group`) for the
  custom query methods? `repo` is the standard and already present on `repo.*`;
  a new name risks divergence. Leaning `repo` for consistency.
- **Migration sequencing with #27.** The key path _requires_ the group in the
  request, but the legacy JWT path still accepts `aud=groupDid`. During the
  deprecation window both must coexist; confirm the key path can rely on the new
  field being present before #27's hard cutover.
- **Service-DID format for `rpc:` scope `aud` (RESOLVED).**
  `@atproto/oauth-scopes` validates the `aud` in an `rpc:` scope with
  `isAtprotoDidRefAbsolute`, which **requires a `did:web:host#fragment`
  service ref** — it rejects a bare `did:web:host` and rejects `did:plc:*`
  entirely. But CGS's `config.serviceDid` is a **bare** `did:web:${hostname}`
  (`src/config.ts`). **Decision:** define one constant `SERVICE_SCOPE_AUD`
  (`${config.serviceDid}#certified_group_service`) used for **both** minting
  (`keys.create` → `RpcPermission.scopeNeededFor`) and checking
  (`gate` → `ScopesSet.matches('rpc', …)`), so it stays internally consistent
  regardless of the bare-DID config value.
  - This scope-layer `aud` is **independent** of the JWT-auth `aud`. The
    JWT-auth check **must stay bare-DID-tolerant**: the reference PDS **strips
    the service fragment** from a proxied JWT's `aud` until Spring 2026
    (atproto.com/specs/xrpc#service-proxying), so requiring a fragment in the
    verifier would break proxied callers. Two `aud` concepts, two rules.
  - The `#certified_group_service` fragment is backed by a real `service` entry:
    CGS now serves its `did:web` document at `/.well-known/did.json` (issue #29).
    So the scope `aud` is both internally consistent and third-party-resolvable.

## Future extensions

- PDS-repo **read** scopes (proxying record reads through the group's PDS).
  Writes shipped in iteration 1; reads are the symmetric follow-up.
- Finer-grained own-only write keys — see the limitation under _Authorization_:
  today own-vs-any follows the issuing owner's role, since AT Protocol `repo:`
  scopes have no ownership axis. A future CGS-specific scope qualifier could let
  an admin mint a self-limited "own records only" key.
- Permission **sets** (named scope bundles) via the `IncludeScope` primitive
  already provided by `@atproto/oauth-scopes`.
- Returning a key in `app.certified.group.register` output (issue comment 1) —
  convenient at registration time but useless for existing groups, so only
  worthwhile once `keys.*` exists anyway.
