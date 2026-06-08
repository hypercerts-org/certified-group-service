import { ScopesSet, RpcPermission, RepoPermission, BlobPermission } from '@atproto/oauth-scopes'
import type { RepoAction } from '@atproto/oauth-scopes'
import type { Operation } from '../rbac/permissions.js'
import { SERVICE_ID_FRAGMENT } from '../did-document.js'

/**
 * The scope-layer `aud` for CGS's own DID, used by `rpc:` scopes.
 *
 * `@atproto/oauth-scopes` validates an `rpc:` scope's `aud` with
 * `isAtprotoDidRefAbsolute`, which **requires a `did:web:host#fragment` service
 * ref** — it rejects a bare `did:web:host` (and all `did:plc:*`). CGS's
 * `config.serviceDid` is a bare `did:web`, so we append the service-id fragment
 * when minting and checking scopes. The same value is used on both sides, so the
 * check is internally consistent regardless of the bare-DID config value.
 *
 * `SERVICE_ID_FRAGMENT` is owned by the identity layer (`src/did-document.ts`)
 * and re-exported here so scope code can use it without a second source of
 * truth — the did:web document's service entry and the scope `aud` cannot drift.
 *
 * Independent of the JWT-auth `aud`, which stays bare-DID tolerant (the
 * reference PDS strips the service fragment from proxied JWTs until Spring
 * 2026). See docs/design/api-keys.md and issue #29 / HYPER-484.
 */
export { SERVICE_ID_FRAGMENT }

/** Build the scope `aud` ref for this service's (bare) DID. */
export function serviceScopeAud(serviceDid: string): string {
  return `${serviceDid}#${SERVICE_ID_FRAGMENT}`
}

/**
 * Map an internal RBAC `Operation` to the XRPC method NSID (lxm) a key scope is
 * declared against. Only operations reachable by an API key need an entry; an
 * operation with no mapping is **not** key-accessible (the gate denies it for
 * key callers). Iteration 1 grants only `member.list`.
 */
const OPERATION_LXM: Partial<Record<Operation, string>> = {
  'member.list': 'app.certified.group.member.list',
  'audit.query': 'app.certified.group.audit.query',
}

/** The lxm an operation maps to, or undefined if it is not key-accessible. */
export function lxmForOperation(operation: Operation): string | undefined {
  return OPERATION_LXM[operation]
}

/**
 * Map a PDS-repo write `Operation` to the AT Protocol `repo:` scope action it
 * requires. These ops act on the group's PDS repo (proxied), so they are gated
 * by `repo:<collection>?action=…` scopes rather than `rpc:`. The collection is
 * not known here — it comes from the request at gate time (`repoScopesCover`).
 *
 * `own`/`any` is **not** a scope axis (AT Protocol `repo:` scopes have no notion
 * of record ownership); that distinction stays in the RBAC role check. So
 * `deleteOwnRecord` and `deleteAnyRecord` map to the same `delete` action — the
 * key's scope says "may delete in this collection", the role decides whose
 * records. See docs/design/api-keys.md.
 */
const OPERATION_REPO_ACTION: Partial<Record<Operation, RepoAction>> = {
  createRecord: 'create',
  putOwnRecord: 'update',
  putAnyRecord: 'update',
  'putRecord:profile': 'update',
  deleteOwnRecord: 'delete',
  deleteAnyRecord: 'delete',
}

/** The `repo:` action an operation needs, or undefined if it is not a repo-write op. */
export function repoActionForOperation(operation: Operation): RepoAction | undefined {
  return OPERATION_REPO_ACTION[operation]
}

/**
 * The `rpc:` scope string an operation requires, or undefined if the operation
 * is not key-accessible. Computed via the package helper, not hand-rolled.
 */
export function scopeNeededFor(operation: Operation, serviceDid: string): string | undefined {
  const lxm = lxmForOperation(operation)
  if (lxm === undefined) return undefined
  return RpcPermission.scopeNeededFor({ lxm, aud: serviceScopeAud(serviceDid) })
}

/**
 * Does a granted scope set cover an operation for this service? Returns false
 * for operations that are not key-accessible (no lxm mapping) — a key can never
 * reach them regardless of its scopes.
 */
export function scopesCoverOperation(
  grantedScopes: string[],
  operation: Operation,
  serviceDid: string,
): boolean {
  const lxm = lxmForOperation(operation)
  if (lxm === undefined) return false
  const granted = ScopesSet.fromString(grantedScopes.join(' '))
  return granted.matches('rpc', { lxm, aud: serviceScopeAud(serviceDid) })
}

/**
 * Does a granted scope set cover a repo-write op on a specific collection? Unlike
 * `rpc:` scopes, `repo:` scopes are keyed by `{collection, action}` and carry no
 * `aud`. The collection comes from the request (the record's collection); the
 * action from `repoActionForOperation`. Returns false if the operation is not a
 * repo-write op.
 */
export function repoScopesCover(
  grantedScopes: string[],
  operation: Operation,
  collection: string,
): boolean {
  const action = repoActionForOperation(operation)
  if (action === undefined) return false
  const granted = ScopesSet.fromString(grantedScopes.join(' '))
  return granted.matches('repo', { collection, action })
}

/**
 * Does a granted scope set cover a blob upload of the given MIME type?
 * `uploadBlob` is gated by a `blob:<accept>` scope (e.g. an all-types or
 * `blob:image/*` accept). CGS proxies the upload to the group's PDS as the group
 * account, so it consumes the group's blob store and is authenticated/scoped
 * even though raw atproto blob upload is low-stakes until a record references it.
 */
export function blobScopesCover(grantedScopes: string[], mime: string): boolean {
  const granted = ScopesSet.fromString(grantedScopes.join(' '))
  return granted.matches('blob', { mime })
}

/**
 * Validate that every scope string in a list parses as a known scope. Used at
 * key-creation time to reject garbage scopes before they are stored. Returns the
 * first invalid scope, or null if all are valid.
 */
export function firstInvalidScope(scopes: string[]): string | null {
  for (const scope of scopes) {
    // Valid if it parses as one of the scope kinds we consume: `rpc:` (service
    // methods), `repo:` (PDS-repo writes), or `blob:` (blob uploads).
    const valid =
      RpcPermission.fromString(scope) !== null ||
      RepoPermission.fromString(scope) !== null ||
      BlobPermission.fromString(scope) !== null
    if (!valid) return scope
  }
  return null
}

/** Outcome of canonicalizing one client-supplied scope string. */
export type ScopeCanonicalization =
  | { ok: true; scope: string }
  | { ok: false; scope: string; reason: string }

/**
 * Canonicalize a client-supplied scope to this service's stored form.
 *
 * - **`rpc:` scopes** are service-bound. A key only ever calls the CGS it was
 *   created on, so the scope `aud` can only be this service's ref. Clients pass
 *   the friendly `rpc:<lxm>` form and we append the `aud`. An already-canonical
 *   `rpc:` scope is accepted **iff** its `aud` is ours; a different `aud` is
 *   rejected (it could never match the gate — a silent dead grant).
 * - **`repo:` scopes** (`repo:<collection>?action=…`) carry **no `aud`** — they
 *   name a collection + action on the group's PDS repo. They are accepted
 *   verbatim after validation; nothing is appended.
 */
export function canonicalizeScope(scope: string, serviceDid: string): ScopeCanonicalization {
  if (scope.startsWith('repo:')) return canonicalizeRepoScope(scope)
  if (scope.startsWith('blob:')) return canonicalizeBlobScope(scope)
  if (scope.startsWith('rpc:')) return canonicalizeRpcScope(scope, serviceDid)
  return { ok: false, scope, reason: 'unsupported scope kind (expected rpc:, repo: or blob:)' }
}

function canonicalizeRpcScope(scope: string, serviceDid: string): ScopeCanonicalization {
  const aud = serviceScopeAud(serviceDid)

  // Already carries params (an `aud=`): accept only if that aud is ours.
  if (scope.includes('?')) {
    const parsed = RpcPermission.fromString(scope)
    if (parsed === null) return { ok: false, scope, reason: 'unparseable scope' }
    if (parsed.aud !== aud) {
      return { ok: false, scope, reason: `scope aud must be this service (${aud})` }
    }
    return { ok: true, scope }
  }

  // Bare `rpc:<lxm>` — derive the lxm and rebuild via the package helper so the
  // stored string is exactly what the gate computes.
  const match = /^rpc:(?<lxm>[^?]+)$/.exec(scope)
  if (!match?.groups?.lxm) return { ok: false, scope, reason: 'not an rpc: scope' }
  const canonical = RpcPermission.scopeNeededFor({ lxm: match.groups.lxm, aud })
  if (RpcPermission.fromString(canonical) === null) {
    return { ok: false, scope, reason: 'invalid rpc method (lxm)' }
  }
  return { ok: true, scope: canonical }
}

function canonicalizeRepoScope(scope: string): ScopeCanonicalization {
  // No aud and nothing to append — just validate the collection?action= form.
  // Re-emit via toString() so the stored string is normalised (e.g. default
  // action set) and matches what the gate computes.
  const parsed = RepoPermission.fromString(scope)
  if (parsed === null) return { ok: false, scope, reason: 'unparseable repo: scope' }
  return { ok: true, scope: parsed.toString() }
}

function canonicalizeBlobScope(scope: string): ScopeCanonicalization {
  // No aud — validate the `blob:<accept>` MIME form and re-emit normalised.
  const parsed = BlobPermission.fromString(scope)
  if (parsed === null) return { ok: false, scope, reason: 'unparseable blob: scope' }
  return { ok: true, scope: parsed.toString() }
}

/**
 * Canonicalize a list of client scopes. Returns the canonical list on success,
 * or the first scope that failed (with a reason) so the caller can surface an
 * `InvalidScope` error naming it.
 */
export function canonicalizeScopes(
  scopes: string[],
  serviceDid: string,
): { ok: true; scopes: string[] } | { ok: false; scope: string; reason: string } {
  const out: string[] = []
  for (const scope of scopes) {
    const result = canonicalizeScope(scope, serviceDid)
    if (!result.ok) return { ok: false, scope: result.scope, reason: result.reason }
    out.push(result.scope)
  }
  return { ok: true, scopes: out }
}
