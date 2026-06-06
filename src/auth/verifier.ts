import { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  verifyJwt as defaultVerifyJwt,
  parseReqNsid as defaultParseReqNsid,
  type MethodAuthVerifier,
} from '@atproto/xrpc-server'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { Request } from 'express'
import type { GlobalDatabase } from '../db/schema.js'
import type { GroupDbPool } from '../db/group-db-pool.js'
import { NonceCache, NONCE_TTL_SECONDS } from './nonce.js'
import { SERVICE_ID_FRAGMENT } from '../did-document.js'
import { parseApiKey, verifySecret } from './api-key.js'

/** Header carrying an API key, kept separate from `Authorization: Bearer` so
 * the JWT path (and its nonce/replay logic) is never reached for key callers. */
export const API_KEY_HEADER = 'x-api-key'

export interface GroupAuthCredentials {
  callerDid: string
  /**
   * The target group DID. Set by the verifier for query methods (from the
   * `repo` querystring, or the legacy `aud` overload). Left undefined for
   * body-input procedures, whose handler resolves it from `input.body.repo`
   * (the verifier runs before the body is parsed).
   */
  groupDid?: string
  /**
   * True when the group was taken from the JWT `aud` claim (the deprecated
   * overload) rather than an explicit `repo`. Drives the deprecation signal.
   *
   * Determined entirely by the verifier, which only sees the querystring (it
   * runs before the body is parsed). So it is true whenever there is no
   * querystring `repo` and `aud` is a group DID — INCLUDING body-input
   * procedures: a legacy procedure call (body `repo` + `aud=<groupDid>`) is
   * still flagged legacy here, because the body `repo` is invisible at auth
   * time. A request only escapes the legacy flag by sending `aud=serviceDid`.
   */
  legacyAud: boolean
  /**
   * Which credential proved the caller. `'jwt'` is the existing service-auth
   * path; `'apiKey'` is the X-API-Key bearer path. The authorization gate uses
   * this to decide whether to apply the scope check (apiKey only) on top of the
   * role check (both).
   */
  authKind: 'jwt' | 'apiKey'
  /**
   * Scope strings granted to the API key (apiKey only). Undefined for JWT
   * callers, who are scope-unlimited and constrained solely by their role.
   */
  scopes?: string[]
  /**
   * The non-secret key id (apiKey only), for attributing audit-log entries to a
   * specific key rather than just the issuing owner DID.
   */
  apiKeyRef?: string
}
export type GroupAuthResult = { credentials: GroupAuthCredentials }

export interface ServiceAuthCredentials {
  callerDid: string
}
export type ServiceAuthResult = { credentials: ServiceAuthCredentials }

export class AuthVerifier {
  private verifyJwtFn: typeof defaultVerifyJwt
  private parseReqNsidFn: typeof defaultParseReqNsid

  constructor(
    private idResolver: IdResolver,
    private nonceCache: NonceCache,
    private globalDb: Kysely<GlobalDatabase>,
    private serviceDid: string,
    private groupDbs: GroupDbPool,
    verifyJwtFn?: typeof defaultVerifyJwt,
    parseReqNsidFn?: typeof defaultParseReqNsid,
  ) {
    this.verifyJwtFn = verifyJwtFn ?? defaultVerifyJwt
    this.parseReqNsidFn = parseReqNsidFn ?? defaultParseReqNsid
  }

  /**
   * Does the JWT `aud` name this service?
   *
   * Accepts the bare service DID (`did:web:<host>`) OR the service DID with
   * exactly our own service-id fragment (`did:web:<host>#certified_group_service`).
   * Under AT Protocol service proxying, the user's PDS sets `aud` to the DID it
   * proxies to; the reference PDS strips the `#fragment` today but is slated to
   * keep it (atproto.com/specs/xrpc#service-proxying), so we must accept both.
   *
   * A *different* fragment (`#something_else`) is deliberately rejected: it names
   * a different service entry on the same host, and a token minted for that
   * service is not for us. The accepted fragment is `SERVICE_ID_FRAGMENT`, the
   * same constant published in our `did:web` document, so the two cannot drift.
   */
  private audMatchesService(aud: string | undefined): boolean {
    if (!aud) return false
    if (aud === this.serviceDid) return true
    return aud === `${this.serviceDid}#${SERVICE_ID_FRAGMENT}`
  }

  private assertTokenLifetime(payload: { iat?: number; exp?: number }): void {
    if (payload.iat == null) {
      throw new AuthRequiredError('Missing iat in service auth token')
    }
    if (payload.exp != null && payload.exp - payload.iat > NONCE_TTL_SECONDS) {
      throw new AuthRequiredError('Token lifetime exceeds nonce window')
    }
  }

  /**
   * Resolve an explicit `repo` value (handle or DID, per the atproto
   * `at-identifier` format) to a registered group DID. Handles are resolved via
   * the DID resolver; the result is validated against the `groups` table.
   * Throws if the repo does not resolve to a known group.
   */
  async resolveRepoToGroup(repo: string): Promise<string> {
    const did = repo.startsWith('did:') ? repo : await this.idResolver.handle.resolve(repo)
    if (!did) {
      throw new AuthRequiredError(`Could not resolve repo to a DID: ${repo}`)
    }
    const group = await this.globalDb
      .selectFrom('groups')
      .where('did', '=', did)
      .select('did')
      .executeTakeFirst()
    if (!group) {
      throw new AuthRequiredError('Unknown group')
    }
    return group.did
  }

  /**
   * Verify a service-auth JWT for a group-scoped method and determine the target
   * group. Two forms are accepted during the deprecation window (issue #27):
   *
   *  - **New (preferred):** an explicit `repo` querystring param names the group
   *    and `aud` is this service's own DID (the correct RFC 7519 meaning).
   *  - **Legacy (deprecated):** no `repo`; the group is taken from `aud`. Flagged
   *    via `legacyAud` so callers can be nudged to migrate.
   *
   * `repo`, when present, wins regardless of `aud`, so a client migrates by
   * simply adding the field. Returns the resolved group (when known here) and
   * whether the legacy path was used.
   *
   * Note: body-input procedures pass `repo` in the body, which is not parsed at
   * auth time — their handler resolves the group via `resolveRepoToGroup`. Such
   * a caller hits the legacy branch here only if it also omits `repo` from the
   * querystring AND sets `aud=<group>`; otherwise it sets `aud=serviceDid` and
   * the verifier returns no group, deferring to the handler.
   */
  async verify(req: Request): Promise<{ iss: string; groupDid?: string; legacyAud: boolean }> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = this.parseReqNsidFn(req)

    // verifyJwt checks: aud, lxm, exp, signature against DID doc.
    // Pass null for aud — we check it ourselves: the new path requires
    // aud === serviceDid, the legacy path repurposes aud as the group DID.
    const payload = await this.verifyJwtFn(
      jwtStr,
      null,
      nsid,
      async (did: string, forceRefresh: boolean): Promise<string> => {
        const atprotoData = await this.idResolver.did.resolveAtprotoData(did, forceRefresh)
        return atprotoData.signingKey
      },
    )

    this.assertTokenLifetime(payload)

    const repoParam = this.readRepoParam(req)

    let groupDid: string | undefined
    let legacyAud: boolean

    if (repoParam !== undefined) {
      // New path: explicit repo names the group; aud must be the service DID.
      if (!this.audMatchesService(payload.aud)) {
        throw new AuthRequiredError('jwt audience does not match service did')
      }
      groupDid = await this.resolveRepoToGroup(repoParam)
      legacyAud = false
    } else if (this.audMatchesService(payload.aud)) {
      // New path for body-input procedures: aud is correct, but the group is in
      // the (not-yet-parsed) body — the handler resolves it. No group here.
      groupDid = undefined
      legacyAud = false
    } else {
      // Legacy path: aud is repurposed as the group DID.
      const group = payload.aud
        ? await this.globalDb
            .selectFrom('groups')
            .where('did', '=', payload.aud)
            .select('did')
            .executeTakeFirst()
        : undefined
      if (!group) {
        throw new AuthRequiredError('Invalid audience')
      }
      groupDid = group.did
      legacyAud = true
    }

    if (!payload.jti) {
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      throw new AuthRequiredError('Replayed token')
    }

    return { iss: payload.iss, groupDid, legacyAud }
  }

  /**
   * Read the `repo` querystring param if present. Express populates `req.query`
   * independently of body parsing, so this is available at auth time for query
   * methods (and for procedures that opt to pass `repo` on the querystring).
   */
  private readRepoParam(req: Request): string | undefined {
    const raw = req.query?.repo
    if (typeof raw === 'string' && raw.length > 0) return raw
    return undefined
  }

  /** Read the `X-API-Key` header value, or undefined if absent/empty. */
  private readApiKeyHeader(req: Request): string | undefined {
    const raw = req.headers[API_KEY_HEADER]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.length > 0) return value
    return undefined
  }

  /**
   * Verify an `X-API-Key` credential and resolve its group + granted scopes.
   *
   * The key carries no group identifier, so the group is named by the request
   * `repo` (querystring) exactly like the new JWT path — the username/password
   * model: the group DID is the "username" (supplied, not secret), the key the
   * "password" (verified against that group's `group_api_keys`). Forward hash
   * only (`DID → group DB`); the per-group-hash reverse mapping is never needed.
   *
   * No nonce, no 2-minute lifetime: keys are long-lived bearer secrets, revoked
   * via `revoked_at`. Scope minimality is the primary mitigation for the larger
   * blast radius (see design doc).
   */
  async verifyApiKey(
    req: Request,
    apiKey: string,
  ): Promise<{ callerDid: string; groupDid: string; scopes: string[]; apiKeyRef: string }> {
    const parsed = parseApiKey(apiKey)
    if (!parsed) {
      throw new AuthRequiredError('Malformed API key')
    }

    // The key path needs the group BEFORE it can authenticate — read it from the
    // request, never from the key. Only the querystring is available at auth time.
    const repoParam = this.readRepoParam(req)
    if (repoParam === undefined) {
      throw new AuthRequiredError('Missing repo for API-key request')
    }
    const groupDid = await this.resolveRepoToGroup(repoParam)

    const groupDb = this.groupDbs.get(groupDid)
    const row = await groupDb
      .selectFrom('group_api_keys')
      .where('key_ref', '=', parsed.keyRef)
      .select(['key_hash', 'scopes', 'created_by', 'revoked_at'])
      .executeTakeFirst()

    // A wrong group or wrong keyRef both land here: no row, no oracle that
    // distinguishes "wrong group" from "wrong key".
    if (!row || row.revoked_at !== null) {
      throw new AuthRequiredError('Invalid API key')
    }
    if (!verifySecret(parsed.secret, row.key_hash)) {
      throw new AuthRequiredError('Invalid API key')
    }

    // Best-effort last-use stamp; never block or fail the request on it.
    void groupDb
      .updateTable('group_api_keys')
      .set({ last_used_at: sql<string>`datetime('now')` })
      .where('key_ref', '=', parsed.keyRef)
      .execute()
      .catch(() => {})

    let scopes: string[]
    try {
      scopes = JSON.parse(row.scopes)
      if (!Array.isArray(scopes)) throw new Error('not an array')
    } catch {
      throw new AuthRequiredError('Corrupt API-key scopes')
    }

    // The key acts on behalf of its issuing owner (design Open Question lean:
    // owner-DID + apiKeyRef for attribution). RBAC stays DID-based.
    return { callerDid: row.created_by, groupDid, scopes, apiKeyRef: parsed.keyRef }
  }

  xrpcAuth(): MethodAuthVerifier<GroupAuthResult> {
    return async ({ req }) => {
      const apiKey = this.readApiKeyHeader(req)
      if (apiKey !== undefined) {
        const { callerDid, groupDid, scopes, apiKeyRef } = await this.verifyApiKey(req, apiKey)
        return {
          credentials: {
            callerDid,
            groupDid,
            legacyAud: false,
            authKind: 'apiKey',
            scopes,
            apiKeyRef,
          },
        }
      }
      const { iss, groupDid, legacyAud } = await this.verify(req)
      return {
        credentials: { callerDid: iss, groupDid, legacyAud, authKind: 'jwt' },
      }
    }
  }

  /**
   * Verify a service auth JWT for service-level (cross-group) endpoints.
   * Audience must be this service's DID rather than a specific group DID.
   */
  async verifyServiceAuth(req: Request): Promise<{ iss: string }> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = this.parseReqNsidFn(req)

    const payload = await this.verifyJwtFn(
      jwtStr,
      this.serviceDid,
      nsid,
      async (did: string, forceRefresh: boolean): Promise<string> => {
        const atprotoData = await this.idResolver.did.resolveAtprotoData(did, forceRefresh)
        return atprotoData.signingKey
      },
    )

    this.assertTokenLifetime(payload)

    if (!payload.jti) {
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      throw new AuthRequiredError('Replayed token')
    }

    return { iss: payload.iss }
  }

  xrpcServiceAuth(): MethodAuthVerifier<ServiceAuthResult> {
    return async ({ req }) => {
      const { iss } = await this.verifyServiceAuth(req)
      return {
        credentials: { callerDid: iss },
      }
    }
  }
}
