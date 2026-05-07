import { IdResolver } from '@atproto/identity'
import { AuthRequiredError, verifyJwt as defaultVerifyJwt, parseReqNsid as defaultParseReqNsid, type MethodAuthVerifier } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { Request } from 'express'
import type { Logger } from 'pino'
import type { GlobalDatabase } from '../db/schema.js'
import { NonceCache, NONCE_TTL_SECONDS } from './nonce.js'

/**
 * Decode the header+payload of a JWT without verifying its signature, for
 * logging purposes only. Returns null on malformed input. The signature is
 * deliberately dropped — it's a bearer credential and must not be logged.
 */
function decodeJwtForLog(jwt: string): { header: unknown; payload: unknown } | null {
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const decode = (s: string): unknown =>
      JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return { header: decode(parts[0]), payload: decode(parts[1]) }
  } catch {
    return null
  }
}

export interface GroupAuthCredentials {
  callerDid: string
  groupDid: string
}
export type GroupAuthResult = { credentials: GroupAuthCredentials }

export interface ServiceAuthCredentials {
  callerDid: string
}
export type ServiceAuthResult = { credentials: ServiceAuthCredentials }

const REGISTER_NSID = 'app.certified.group.register'

export class AuthVerifier {
  private verifyJwtFn: typeof defaultVerifyJwt
  private parseReqNsidFn: typeof defaultParseReqNsid
  private logger?: Logger

  constructor(
    private idResolver: IdResolver,
    private nonceCache: NonceCache,
    private globalDb: Kysely<GlobalDatabase>,
    private serviceDid: string,
    verifyJwtFn?: typeof defaultVerifyJwt,
    parseReqNsidFn?: typeof defaultParseReqNsid,
    logger?: Logger,
  ) {
    this.verifyJwtFn = verifyJwtFn ?? defaultVerifyJwt
    this.parseReqNsidFn = parseReqNsidFn ?? defaultParseReqNsid
    this.logger = logger
  }

  /**
   * Log an auth failure with enough context to diagnose prod 401s without
   * leaking the JWT signature. Header+payload only; raw token is never logged.
   */
  private logAuthFailure(
    reason: string,
    nsid: string | undefined,
    jwt: string,
    extra: Record<string, unknown> = {},
  ): void {
    if (!this.logger) return
    const decoded = decodeJwtForLog(jwt)
    this.logger.warn(
      { reason, nsid, jwt: decoded, ...extra },
      'Auth verification failed',
    )
  }

  private assertTokenLifetime(payload: { iat?: number; exp?: number }): void {
    if (payload.iat == null) {
      throw new AuthRequiredError('Missing iat in service auth token')
    }
    if (payload.exp != null && payload.exp - payload.iat > NONCE_TTL_SECONDS) {
      throw new AuthRequiredError('Token lifetime exceeds nonce window')
    }
  }

  async verify(req: Request): Promise<{ iss: string; aud: string }> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      this.logger?.warn(
        { reason: 'Missing auth token', path: req.originalUrl ?? req.path },
        'Auth verification failed',
      )
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = this.parseReqNsidFn(req)

    // verifyJwt checks: aud, lxm, exp, signature against DID doc.
    // Pass null for aud — we check it ourselves because we support multiple groups.
    let payload
    try {
      payload = await this.verifyJwtFn(
        jwtStr,
        null,
        nsid,
        async (did: string, forceRefresh: boolean): Promise<string> => {
          const atprotoData = await this.idResolver.did.resolveAtprotoData(
            did,
            forceRefresh,
          )
          return atprotoData.signingKey
        },
      )
    } catch (err) {
      this.logAuthFailure('verifyJwt threw', nsid, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    try {
      this.assertTokenLifetime(payload)
    } catch (err) {
      this.logAuthFailure('Token lifetime check failed', nsid, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    const group = payload.aud
      ? await this.globalDb
          .selectFrom('groups')
          .where('did', '=', payload.aud)
          .select('did')
          .executeTakeFirst()
      : undefined
    if (!group) {
      this.logAuthFailure('Invalid audience', nsid, jwtStr, {
        groupFound: false,
      })
      throw new AuthRequiredError('Invalid audience')
    }

    if (!payload.jti) {
      this.logAuthFailure('Missing jti', nsid, jwtStr)
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      this.logAuthFailure('Replayed token', nsid, jwtStr)
      throw new AuthRequiredError('Replayed token')
    }

    return { iss: payload.iss, aud: payload.aud }
  }

  /**
   * Verify a service auth JWT for the registration endpoint.
   * Proves the caller controls the claimed DID by checking the JWT signature
   * against their DID document's signing key. Audience must be this service's DID.
   */
  async verifyRegistration(req: Request): Promise<{ iss: string }> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      this.logger?.warn(
        { reason: 'Missing auth token', nsid: REGISTER_NSID, path: req.originalUrl ?? req.path },
        'Auth verification failed',
      )
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)

    let payload
    try {
      payload = await this.verifyJwtFn(
        jwtStr,
        this.serviceDid,
        REGISTER_NSID,
        async (did: string, forceRefresh: boolean): Promise<string> => {
          const atprotoData = await this.idResolver.did.resolveAtprotoData(
            did,
            forceRefresh,
          )
          return atprotoData.signingKey
        },
      )
    } catch (err) {
      this.logAuthFailure('verifyJwt threw', REGISTER_NSID, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    try {
      this.assertTokenLifetime(payload)
    } catch (err) {
      this.logAuthFailure('Token lifetime check failed', REGISTER_NSID, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    if (!payload.jti) {
      this.logAuthFailure('Missing jti', REGISTER_NSID, jwtStr)
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      this.logAuthFailure('Replayed token', REGISTER_NSID, jwtStr)
      throw new AuthRequiredError('Replayed token')
    }

    return { iss: payload.iss }
  }

  xrpcAuth(): MethodAuthVerifier<GroupAuthResult> {
    return async ({ req }) => {
      const { iss, aud } = await this.verify(req)
      return {
        credentials: { callerDid: iss, groupDid: aud },
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
      this.logger?.warn(
        { reason: 'Missing auth token', path: req.originalUrl ?? req.path },
        'Auth verification failed',
      )
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = this.parseReqNsidFn(req)

    let payload
    try {
      payload = await this.verifyJwtFn(
        jwtStr,
        this.serviceDid,
        nsid,
        async (did: string, forceRefresh: boolean): Promise<string> => {
          const atprotoData = await this.idResolver.did.resolveAtprotoData(
            did,
            forceRefresh,
          )
          return atprotoData.signingKey
        },
      )
    } catch (err) {
      this.logAuthFailure('verifyJwt threw', nsid, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    try {
      this.assertTokenLifetime(payload)
    } catch (err) {
      this.logAuthFailure('Token lifetime check failed', nsid, jwtStr, {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    if (!payload.jti) {
      this.logAuthFailure('Missing jti', nsid, jwtStr)
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      this.logAuthFailure('Replayed token', nsid, jwtStr)
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
