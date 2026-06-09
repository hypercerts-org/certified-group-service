# Design: Permission Sets (`include:` scopes)

Status: **Proposed** (iteration 2 of API keys — builds on
[`api-keys.md`](api-keys.md))

Tracking issues:

- (fill in) — Permission-set / `include:` support for API keys
- [#26 — API-key framework for all CGS XRPCs](https://github.com/hypercerts-org/certified-group-service/issues/26)
  (iteration 1, the foundation this extends)

## Motivation

Iteration 1 ([`api-keys.md`](api-keys.md)) lets an owner mint an API key with an
explicit list of `rpc:` / `repo:` / `blob:` scopes. That is precise but verbose:
a backend that does CRUD over a family of record collections must enumerate
every `repo:<collection>?action=…` scope by hand. The list is easy to get wrong
and has to be re-derived by every integrator from scratch.

The AT Protocol permission spec already names the fix:
[**permission sets**](https://atproto.com/specs/permission#permission-sets) — a
named, published, reusable bundle of scopes, referenced with a single
`include:<nsid>` scope. The iteration-1 design explicitly deferred this, flagging
`IncludeScope` as "the 'permission set' (named bundle) primitive, _for later_"
([`api-keys.md`](api-keys.md), "Can we reuse the AT Protocol permission spec?").
This document is that "later".

## A permission set is a shared, published artifact — two consumers

The central framing. A permission set is **not** a CGS-specific object. Per the
spec it is *"published publicly and can be used by any client developer"*, and
*"Authorization Servers resolve, authenticate, and process permission-sets
dynamically."* The same published set serves two consumers:

1. **OAuth clients** — a client requests `include:<nsid>` as an OAuth scope; the
   user's PDS (the Authorization Server) resolves the set and expands it into the
   underlying scopes in the grant. This is the **primary** use case: CGS is used
   as a standard OAuth resource in production, reached via AT Protocol service
   proxying, and a client integrating with the Certified / Hypercerts record
   types wants one named scope rather than a hand-written list.
2. **CGS API-key creation** — when `keys.create` receives an `include:<nsid>`
   scope, CGS resolves the **same** published set and expands it to concrete
   scopes stored on the key.

So the **published Lexicon record is the single source of truth**. If CGS keeps
a local copy of a set for fast resolution, that is an implementation cache, not a
separate kind of object — it must match what is published.

> **Publication is handled out-of-band.** Publishing the sets (DNS `_lexicon`
> TXT → authority DID → `com.atproto.lexicon.schema` records) is owned by the
> namespace operators and is **not** in scope for this document. It is known to
> be possible (the spec defines the mechanism; see _Resolution_ below). This
> design only needs to assume a published set is resolvable.

## Which sets, and where they live

A permission set may only contain permissions under its **own** namespace
authority — spec, verbatim: *"Permission sets are limited to expressing
permissions that reference resources under the same NSID namespace as the set
itself."* It applies uniformly to `repo:` (by collection NSID) and `rpc:` (by lxm
NSID). So a set lives under, and is authored/published by, the authority of the
namespace it grants.

The sets we actually need are **record-collection CRUD** bundles — the genuine
"a backend needs create/update/delete over all of these collections" case. Two,
both `repo:` sets, both authored and published from the **`hypercerts-lexicon`**
repo (which is the authority for both namespaces):

| Set (suggested NSID) | Grants CRUD on | Authored in |
| --- | --- | --- |
| `org.hypercerts.permissions.crud` | all `org.hypercerts.*` record collections | `hypercerts-lexicon` |
| `app.certified.permissions.crud` | all `app.certified.*` record collections | `hypercerts-lexicon` |

Both are to be tracked by one issue in that repo (to be filed there, with the
full enumerated collection lists, after this design lands).

### No CGS service-method set (initially)

CGS's own service methods (`app.certified.group.*` / `app.certified.groups.*`)
are `rpc:` resources. We considered a CGS-method set (e.g. bundling `member.list`
+ `audit.query`) and **rejected it**: those methods are *fundamentally different*
permissions with no use case that wants exactly them together — grouping them
would bundle by grammar ("they're all reads"), not by what any client needs. A
set earns its place only when a known consumer repeatedly needs a specific
multi-scope bundle; absent that, clients request the individual `rpc:` scopes
they need. If such a use case appears, a CGS-method set can be added later (under
CGS's own `app.certified.group.*` authority, which this repo controls).

## Background: how `@atproto/oauth-scopes` models a permission set

Verified against `@atproto/oauth-scopes@0.5.0` (the version CGS pins). Two types
plus one class do the work:

```ts
// lib/lexicon.d.ts
type LexiconPermission<P extends string = string> = {
  readonly type: 'permission'
  readonly resource: P // 'repo' | 'rpc' | …
  readonly [x: string]: undefined | ParamValue | readonly ParamValue[]
}
type LexiconPermissionSet = {
  readonly type: 'permission-set'
  readonly permissions: readonly LexiconPermission<string>[]
  readonly title?: string
  readonly detail?: string
  // + title:lang / detail:lang localisation maps
}

// scopes/include-scope.d.ts
class IncludeScope {
  readonly nsid: Nsid
  readonly aud: undefined | AtprotoDidRefAbsolute
  static fromString(scope: string): IncludeScope | null // parses "include:<nsid>[?aud=…]"
  toScopes(set: LexiconPermissionSet): Array<ScopeStringFor<'repo' | 'rpc'>>
  toPermissions(set: LexiconPermissionSet): Array<RepoPermission | RpcPermission>
  isParentAuthorityOf(otherNsid: '*' | Nsid): boolean
}
```

The critical guardrail is **namespace authority**: `IncludeScope` only pulls
permissions whose NSID is under the authority of the set's own NSID
(`isParentAuthorityOf` / its internal `isAllowedPermission`). A set under
`org.hypercerts.*` can grant `repo:org.hypercerts.*` but cannot smuggle in a
foreign-authority permission. This is what makes resolving a remote, third-party
set safe.

### Collections are enumerated, never wildcarded

A `repo:` permission inside a set names collections by **exact NSID**. The spec,
verbatim: *"Wildcards are not supported in permissions within a permission set."*
So a CRUD set cannot say "all `org.hypercerts.*` collections" — it **enumerates**
each one. The enumerated list *is* the grant and the security boundary; a new
collection is uncovered until it is added to the set and re-published.

## `aud` and `inheritAud`

An `rpc:` scope authorizes "call method *lxm* at audience *aud*" — `aud` names
**which service**. A `repo:` scope has **no** `aud` (it targets the user's own
repo).

- For an **OAuth client**, `aud` is load-bearing: the grant lives on the user's
  PDS, which proxies to many services, so the scope must say which service it
  authorizes. The client supplies `aud` on the `include:` (`include:<nsid>?aud=…`)
  and, per spec, *"the `aud` parameter on the `include` will be passed down to
  those specific `rpc` permissions"* marked `inheritAud: true`.
- For a **CGS API key**, `aud` is redundant — a key is only ever presented to
  CGS — but the `@atproto/oauth-scopes` grammar still requires an `aud` on a
  parsed `rpc:` scope. So CGS stamps its own service ref as a formality.

`inheritAud` keeps a published set **deployment-agnostic**: the set file hard-codes
no service DID; whoever invokes the `include:` supplies the concrete `aud`. The
two CRUD sets are `repo:`-only, so this is moot for them — but it is the reason a
future `rpc:` set would use `inheritAud` rather than baking in CGS's DID.

## Decision: CGS expands `include:` at key-create time

For the **CGS API-key** consumer, an `include:` scope is a **create-time
convenience**, not a stored credential form. When `keys.create` receives
`include:<nsid>`:

1. resolve the published `LexiconPermissionSet` for the NSID,
2. call `includeScope.toScopes(set)` to get concrete `repo:`/`rpc:` strings,
3. run those through the **existing** `canonicalizeScopes` and store the result.

The key row stores only concrete scopes, exactly as iteration 1. The verifier and
the authz gate (`assertCanWithAudit`, `repoScopesCover`) are **unchanged** — they
never see an `include:`.

### Why create-time, not request-time

- **Zero change downstream.** Storage, verifier, and gate already operate on
  concrete scopes; expansion stays inside the create path.
- **No live dependency on a remote set at request time** (the hot path). A key
  keeps working even if the set's PDS is later unreachable.

### Trade-off

Expanding at create time **freezes** the set into the key: if a set later
changes, keys already minted keep the old expansion until re-issued. Intentional;
must be stated in the user-facing API docs — an `include:`-minted key is a
snapshot, not a live subscription. (The OAuth consumer has no such freeze — the
AS expands per grant.)

## Resolution

Both consumers resolve a published set via the standard **Lexicon resolution
system** (the permission spec defers to it; chain verified against
[`/specs/lexicon`](https://atproto.com/specs/lexicon), core protocol, not
experimental):

1. **NSID → authority DID via DNS.** Reverse the NSID's authority portion (all
   but the final name), prepend `_lexicon.`, query that domain for a `TXT` record
   `did=<DID>`.
2. **DID → PDS endpoint** via `ctx.idResolver` (`@atproto/identity`, PLC-cached —
   already used in `src/auth/verifier.ts`, `src/api/group/import.ts`).
3. **Fetch the schema record**: `com.atproto.repo.getRecord` with
   `repo=<authority-DID>`, `collection=com.atproto.lexicon.schema`,
   `rkey=<full-NSID>` (the rkey **is** the NSID).
4. Validate the record's `main` def is `type: 'permission-set'` and hand it to
   `IncludeScope.toScopes` — whose authority check guarantees the set can only
   widen access to its own namespace.

For the **OAuth** consumer the user's PDS does this. For the **CGS API-key**
consumer CGS does it at `keys.create`.

> **The DNS step is the one new piece for CGS.** `@atproto/identity`'s
> `IdResolver` handles handle/DID/DID-doc resolution but **not** `_lexicon.`
> NSID-authority TXT lookups; a follow-up adds that resolver plus a spec-compliant
> cache (the spec recommends a **~24h stale lifetime**, and warns *not* to
> long-cache the DNS step). Until that lands, CGS API keys that reference a set
> are rejected at create with a clear error; a backend still lists its concrete
> `repo:org.hypercerts.<x>?action=…` scopes explicitly (exactly as iteration-1
> keys do). The OAuth consumer is unaffected — the PDS already resolves sets.

### Failure semantics (CGS key-create)

- Resolution happens **once, at key-create time**, never per request.
- A create that references an unresolvable or non-permission-set NSID **fails**
  with a clear error (`InvalidScope` / a new `UnresolvablePermissionSet`), rather
  than minting a partial key.

## Wiring it into `keys.create`

Contained in the scope layer + create handler:

1. **`src/auth/scopes.ts`** — add a step that runs **before** `canonicalizeScopes`
   and rewrites the incoming scope list, replacing each `include:` with its
   expanded `repo:`/`rpc:` scopes; the existing `canonicalizeScopes` then
   validates/normalises the whole list as today:

   ```ts
   // expandIncludes(scopes, ctx) -> string[]
   for (const scope of scopes) {
     const inc = IncludeScope.fromString(scope)
     if (!inc) { out.push(scope); continue }          // not an include: -> pass through
     const set = await resolvePermissionSet(ctx, inc.nsid)  // Lexicon resolution (cached)
     out.push(...inc.toScopes(set))                   // authority-checked by the lib
   }
   ```

   `firstInvalidScope` / `canonicalizeScope` currently reject anything that is not
   `rpc:`/`repo:`/`blob:` — `include:` must be expanded away *before* it reaches
   them, so they need no new branch (they only ever see concrete scopes).

   > **Confirm at implementation:** that `IncludeScope.toScopes` applies an
   > invocation `aud` to `inheritAud` permissions outside a full OAuth grant. If
   > not, construct the expanded `rpc:` strings with
   > `RpcPermission.scopeNeededFor({lxm, aud})` directly. (Moot for the two `repo:`
   > CRUD sets, which carry no `aud`.)

2. **`src/api/keys/create.ts`** — call the expansion step before
   `canonicalizeScopes` (handler is already async). Surface resolution failures
   as a 400.

3. **`src/context.ts` / boot** — wire the set resolver (and its cache) onto
   `AppContext`.

4. **Lexicon `keys.create` input doc** — broaden the `scopes` description to
   mention the `include:` form; no schema change (still `string[]`).

No change to: the `group_api_keys` schema, the verifier, the authz gate, or the
RBAC role check. Expanded scopes are stored and enforced exactly as iteration-1
scopes are.

## Worked examples

### As an OAuth scope (primary)

A client integrating with the Hypercerts record types requests one scope in its
OAuth authorization:

```
include:org.hypercerts.permissions.crud
```

The user's PDS resolves the published set and expands it to one
`repo:<collection>?action=create&action=update&action=delete` scope **per
enumerated collection**, granting CRUD on those collections in the user's own
repo. (No `?aud=` — `repo:` scopes have no audience.)

### As a CGS API-key scope

```
POST app.certified.group.keys.create
{ "repo": "<group>", "name": "hypercerts-backend",
  "scopes": ["include:org.hypercerts.permissions.crud"] }
```

CGS resolves the same set and expands it; the returned `scopes` array shows the
**expanded** snapshot the key carries:

```jsonc
{
  "keyRef": "…",
  "key": "…",                       // once
  "scopes": [
    "repo:org.hypercerts.claim.activity?action=create&action=update&action=delete",
    "repo:org.hypercerts.claim.contribution?action=create&action=update&action=delete",
    "…one per org.hypercerts.* collection…"
  ],
  "createdAt": "…"
}
```

The key then calls CGS's own write methods —
`app.certified.group.repo.createRecord` / `putRecord` / `deleteRecord` (which
proxy to the group's PDS) — with `{ repo: "<group>", collection:
"org.hypercerts.claim.activity", record: {…} }`. The gate matches the request's
`collection` against the `repo:` scopes and permits it, denying any unlisted
collection. For blob upload the caller adds an explicit `blob:` scope (it cannot
ride in a set — see non-goals).

## Non-goals (this iteration)

- **`blob:` via include.** `IncludeScope.toScopes()` emits only `repo:`/`rpc:`
  permissions; the permission-set form carries no blob accepts. A key needing
  blob upload passes an explicit `blob:` scope alongside any `include:`.
- **Authoring/publishing the sets.** Owned by the namespace operators
  (`hypercerts-lexicon`), tracked by a separate issue. This repo only *consumes*
  sets.
- **Re-expanding issued keys when a set changes.** We expand at create time; an
  `include:`-minted key is a snapshot.
- **A CGS service-method (`rpc:`) set.** No current use case (see above).

## The key-accessible surface — what any set can and cannot grant

Regardless of which set or scopes a key holds, its reachable operations are
**floor-capped by CGS code**, not by the permission set: the authz gate
(`src/api/util.ts`) only ever consults a scope for ops present in
`OPERATION_LXM` / `OPERATION_REPO_ACTION` (`src/auth/scopes.ts`); any op absent
from both maps is denied to a key caller **regardless of scopes**. Today that
surface is exactly: `member.list`, `audit.query` (rpc), the `repo:` write actions
(create/update/delete), and `uploadBlob` (blob).

Consequently **no scope or set** can grant key administration (`keys.create`,
`keys.delete`) or membership administration (`member.add`, `member.remove`,
`role.set`). These are deliberately not key-accessible (iteration-1 design; see
the `keys.create` handler comment "a key cannot mint keys"). This bounds the
blast radius of any key, however broadly scoped: it cannot escalate by minting
more keys nor alter the member roster. (This floor-cap applies to the CGS
API-key consumer; an OAuth grant's reach is governed by the user's PDS plus
whatever CGS's gate enforces on the proxied call.)

## On parameterization

A set cannot be parameterized by group/repo. Verified against the spec and
`@atproto/oauth-scopes@0.5.0`: the only parameter `include:` passes down is `aud`
(via `inheritAud`). `RpcPermission` carries `{lxm, aud}`, `RepoPermission`
carries `{collection, action}` — no DID/repo axis on either. For CGS API keys
this is irrelevant anyway: a key is bound to one group by **storage** (minted
against the request's `repo`, stored in that group's per-group DB, only resolved
under that group — there is no cross-group key), not by any scope. Group and
scope set are orthogonal axes.

## Open questions

**None block this iteration's CGS work.**

- **DNS-TXT NSID-authority resolver + cache** — the one new piece CGS needs to
  resolve published sets at key-create time (not provided by
  `@atproto/identity`). Mechanism is confirmed (see _Resolution_); it is build
  work, not an unknown. May ship in this iteration or a follow-up.

_Recorded so they are not re-litigated:_

- **Set lineup:** two `repo:` CRUD sets (`org.hypercerts.*`, `app.certified.*`),
  published from `hypercerts-lexicon`. No CGS-method set.
- **Wildcards:** forbidden inside a set — collections are enumerated.
- **`aud`/`inheritAud`:** load-bearing for the OAuth consumer; a formality for
  the API-key consumer.

## Future extensions

- **Request-time expansion** (live set propagation) for CGS keys, if a "key
  follows the set" semantics is ever needed — a separate iteration with a
  gate-side resolver cache.
- **`blob:` in sets**, if/when the spec carries blob accepts and the library
  expands them.
- **A CGS service-method set**, if a concrete consumer needs a recurring bundle
  of `app.certified.group.*` methods.
