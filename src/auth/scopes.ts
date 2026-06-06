import { ScopesSet, RpcPermission } from '@atproto/oauth-scopes'
import type { Operation } from '../rbac/permissions.js'

/**
 * Service-id fragment for CGS's own DID, used as the `aud` of `rpc:` scopes.
 *
 * `@atproto/oauth-scopes` validates an `rpc:` scope's `aud` with
 * `isAtprotoDidRefAbsolute`, which **requires a `did:web:host#fragment` service
 * ref** — it rejects a bare `did:web:host` (and all `did:plc:*`). CGS's
 * `config.serviceDid` is a bare `did:web`, so we append this fragment when
 * minting and checking scopes. The same constant is used on both sides, so the
 * check is internally consistent regardless of the bare-DID config value.
 *
 * Independent of the JWT-auth `aud`, which stays bare-DID tolerant (the
 * reference PDS strips the service fragment from proxied JWTs until Spring
 * 2026). See docs/design/api-keys.md and issue #29 / HYPER-484.
 */
export const SERVICE_ID_FRAGMENT = 'certified_group_service'

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
 * Validate that every scope string in a list parses as a known scope. Used at
 * key-creation time to reject garbage scopes before they are stored. Returns the
 * first invalid scope, or null if all are valid.
 */
export function firstInvalidScope(scopes: string[]): string | null {
  for (const scope of scopes) {
    // A scope is valid if any resource permission parser accepts it. We only
    // emit/consume `rpc:` scopes in iteration 1, so check that form.
    if (RpcPermission.fromString(scope) === null) return scope
  }
  return null
}
