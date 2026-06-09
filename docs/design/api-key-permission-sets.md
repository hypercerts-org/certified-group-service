# Design: Permission Sets (`include:` scopes) for CGS API keys

Status: **Implemented** (iteration 2 of API keys — builds on
[`api-keys.md`](api-keys.md))

> **Scope of this doc.** Permission sets are a general AT Protocol mechanism, and
> the two sets CGS consumes (`org.hypercerts.authWrite`,
> `app.certified.authWrite`) are designed, defined, and published in the
> **`hypercerts-lexicon`** repo. The canonical design — what a permission set is,
> the namespace-authority rule, why there are two sets, wildcards, `aud` /
> `inheritAud`, the Lexicon resolution chain, the set contents — lives there:
> [hypercerts-lexicon `docs/design/permission-sets.md`](https://github.com/hypercerts-org/hypercerts-lexicon/blob/main/docs/design/permission-sets.md).
>
> **This doc covers only the CGS-specific part:** how a CGS **API key** consumes
> an `include:<nsid>` scope. It does not restate the lexicon doc.

Tracking issues:

- [#26 — API-key framework for all CGS XRPCs](https://github.com/hypercerts-org/certified-group-service/issues/26)
  (iteration 1, the foundation this extends)

(No dedicated tracking issue for `include:` support yet; this doc is the
current record. Add one here when filed.)

## Context

Iteration 1 ([`api-keys.md`](api-keys.md)) lets an owner mint an API key with an
explicit list of `rpc:` / `repo:` / `blob:` scopes. That is precise but verbose:
a backend that does CRUD over a family of record collections must enumerate every
`repo:<collection>?action=…` scope by hand. A **permission set** collapses that
to one `include:<nsid>` scope (see the lexicon doc above for the full rationale).

CGS is **one consumer** of these published sets. The other — the primary one — is
an ordinary OAuth client, whose `include:` scope is resolved and expanded by the
**user's PDS** during the OAuth grant; that path needs nothing from CGS and is
covered by the lexicon doc and the [integration guide](../integration-guide.md).
The rest of this document is purely about the **API-key** path.

## Decision: CGS expands `include:` at key-create time

When `keys.create` receives an `include:<nsid>` scope, CGS resolves the published
set and expands it to concrete `repo:`/`rpc:` scopes **stored on the key** —
once, at creation. The key row stores only concrete scopes, exactly as
iteration 1; the verifier and authz gate (`assertCanWithAudit`, `repoScopesCover`)
are **unchanged** — they never see an `include:`.

Why create-time, not request-time:

- **Zero change downstream.** Storage, verifier, and gate already operate on
  concrete scopes; expansion stays inside the create path.
- **No live dependency on a remote set at request time** (the hot path) — a key
  keeps working even if the set's PDS is later unreachable.

**Trade-off:** create-time expansion **freezes** the set into the key — if the
published set later changes, keys already minted keep the old expansion until
re-issued. An `include:`-minted key is a snapshot, not a live subscription. (This
is a CGS-API-key property; the OAuth consumer has no such freeze — the user's PDS
expands per grant.) Note this in the user-facing API docs.

## Status: implemented

`keys.create` accepts an `include:<nsid>` scope and expands it (via
`expandIncludes` in `src/auth/scopes.ts`, resolving the set with
`PermissionSetResolver` in `src/auth/permission-set-resolver.js`) into the
concrete scopes stored on the key. An `include:` whose set cannot be resolved is
rejected with `400 InvalidScope`, naming the offending scope; no partial key is
minted. The resolver is **namespace-agnostic** — it resolves any published set
via that set's own namespace authority, with no built-in knowledge of
`org.hypercerts.*` / `app.certified.*`.

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
     if (!inc) {
       out.push(scope)
       continue
     } // not an include: -> pass through
     const set = await resolvePermissionSet(ctx, inc.nsid) // Lexicon resolution (cached)
     out.push(...inc.toScopes(set)) // authority-checked by the lib
   }
   ```

   `firstInvalidScope` / `canonicalizeScope` currently reject anything that is not
   `rpc:`/`repo:`/`blob:` — `include:` must be expanded away _before_ it reaches
   them, so they need no new branch (they only ever see concrete scopes).

2. **`src/api/keys/create.ts`** — call the expansion step before
   `canonicalizeScopes` (handler is already async). Surface resolution failures
   as a 400 (`InvalidScope` / a new `UnresolvablePermissionSet`); never mint a
   partial key.

3. **`src/context.ts` / boot** — wire the set resolver (and its cache) onto
   `AppContext`.

4. **Lexicon `keys.create` input doc** — broaden the `scopes` description to
   mention the `include:` form; no schema change (still `string[]`).

No change to: the `group_api_keys` schema, the verifier, the authz gate, or the
RBAC role check. Expanded scopes are stored and enforced exactly as iteration-1
scopes are.

### Resolving the set from CGS

CGS resolves a published set via the standard Lexicon resolution chain (defined
in the lexicon doc): NSID → `_lexicon.` DNS TXT → authority DID → PDS →
`com.atproto.lexicon.schema` record → validate `permission-set` →
`IncludeScope.toScopes`.

> **The DNS step is the one new piece CGS needs.** `@atproto/identity`'s
> `IdResolver` (already used in `src/auth/verifier.ts`, `src/api/group/import.ts`)
> handles handle/DID/DID-doc resolution but **not** `_lexicon.` NSID-authority TXT
> lookups. A follow-up adds that resolver plus a spec-compliant cache (the spec
> recommends a ~24h stale lifetime and warns not to long-cache the DNS step).
> Mechanism is confirmed — it is build work, not an unknown.
>
> **Confirm at implementation:** that `IncludeScope.toScopes` applies an
> invocation `aud` to `inheritAud` permissions outside a full OAuth grant. If not,
> construct the expanded `rpc:` strings with
> `RpcPermission.scopeNeededFor({lxm, aud})` directly. (Moot for the two `repo:`
> CRUD sets, which carry no `aud`.)

## Worked example (API-key path)

```text
POST app.certified.group.keys.create
{ "repo": "<group>", "name": "hypercerts-backend",
  "scopes": ["include:org.hypercerts.authWrite"] }
```

CGS resolves the set and expands it; the returned `scopes` array is the
**expanded** snapshot the key carries:

```jsonc
{
  "keyRef": "…",
  "key": "…", // once
  "scopes": [
    "repo:org.hypercerts.claim.activity?action=create&action=update&action=delete",
    "…one per org.hypercerts.* collection…",
  ],
  "createdAt": "…",
}
```

The key then calls CGS's own write methods —
`app.certified.group.repo.createRecord` / `putRecord` / `deleteRecord` (which
proxy to the group's PDS) — with `{ repo, collection, record }`. The gate matches
the request's `collection` against the key's `repo:` scopes and permits it,
denying any unlisted collection. Blob upload needs an explicit `blob:` scope
alongside any `include:` (the permission-set form carries no blob accepts).

## CGS-specific: the key-accessible surface caps what any set can grant

This is the one substantive CGS constraint not in the lexicon doc. Regardless of
which set or scopes a key holds, a key's reachable operations are **floor-capped
by CGS code**: the authz gate (`src/api/util.ts`) only consults a scope for ops
present in `OPERATION_LXM` / `OPERATION_REPO_ACTION` (`src/auth/scopes.ts`); any
op absent from both is denied to a key caller **regardless of scopes**. Today
that surface is exactly: `member.list`, `audit.query` (rpc), the `repo:` write
actions, and `uploadBlob` (blob).

Consequently **no scope or set** can grant key administration (`keys.create`,
`keys.delete`) or membership administration (`member.add`, `member.remove`,
`role.set`) — deliberately not key-accessible (iteration-1 design; see the
`keys.create` handler comment "a key cannot mint keys"). An `include:`-minted key
is bounded by this just like an explicitly-scoped one: it cannot escalate by
minting more keys nor alter the member roster.

Also CGS-specific: a key is bound to **one group** by storage (minted against the
request's `repo`, stored in that group's per-group DB, only resolved under that
group — no cross-group key), independent of its scopes. Group and scope set are
orthogonal axes; a permission set carries no group/repo parameter (none exists in
the scope grammar — see the lexicon doc's parameterization note).

## Open questions

**None block this iteration's CGS work.** The only new build piece is the
DNS-TXT NSID-authority resolver + cache (above); mechanism is confirmed.

## Future extensions

- **Request-time expansion** (live set propagation) for CGS keys, if a "key
  follows the set" semantics is ever needed — a separate iteration with a
  gate-side resolver cache.
- **A CGS service-method (`rpc:`) set**, if a concrete consumer ever needs a
  recurring bundle of `app.certified.group.*` methods. (None today — see the
  lexicon doc on why grouping unrelated methods isn't worthwhile.)
