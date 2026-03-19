import { IdResolver } from '@atproto/identity'
import { AuthRequiredError, verifyJwt as defaultVerifyJwt, parseReqNsid as defaultParseReqNsid, type MethodAuthVerifier } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { Request } from 'express'
import type { GlobalDatabase } from '../db/schema.js'
import { NonceCache, NONCE_TTL_SECONDS } from './nonce.js'

export interface GroupAuthCredentials {
  callerDid: string
  groupDid: string
}
export type GroupAuthResult = { credentials: GroupAuthCredentials }

const REGISTER_NSID = 'app.certified.group.register'

const ACCEPTED_NSIDS = new Set([
  'com.atproto.repo.createRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.uploadBlob',
  'app.certified.group.repo.createRecord',
  'app.certified.group.repo.deleteRecord',
  'app.certified.group.repo.putRecord',
  'app.certified.group.repo.uploadBlob',
  'app.certified.group.member.list',
  'app.certified.group.member.add',
  'app.certified.group.member.remove',
  'app.certified.group.role.set',
  'app.certified.group.audit.query',
])

export class AuthVerifier {
  private verifyJwtFn: typeof defaultVerifyJwt
  private parseReqNsidFn: typeof defaultParseReqNsid

  constructor(
    private idResolver: IdResolver,
    private nonceCache: NonceCache,
    private globalDb: Kysely<GlobalDatabase>,
    private serviceDid: string,
    verifyJwtFn?: typeof defaultVerifyJwt,
    parseReqNsidFn?: typeof defaultParseReqNsid,
  ) {
    this.verifyJwtFn = verifyJwtFn ?? defaultVerifyJwt
    this.parseReqNsidFn = parseReqNsidFn ?? defaultParseReqNsid
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
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = this.parseReqNsidFn(req)

    if (!ACCEPTED_NSIDS.has(nsid)) {
      throw new AuthRequiredError(`Unsupported NSID: ${nsid}`)
    }

    // verifyJwt checks: aud, lxm, exp, signature against DID doc.
    // Pass null for aud — we check it ourselves because we support multiple groups.
    const payload = await this.verifyJwtFn(
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

    this.assertTokenLifetime(payload)

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

    if (!payload.jti) {
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
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
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)

    const payload = await this.verifyJwtFn(
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

  xrpcAuth(): MethodAuthVerifier<GroupAuthResult> {
    return async ({ req }) => {
      const { iss, aud } = await this.verify(req)
      return {
        credentials: { callerDid: iss, groupDid: aud },
      }
    }
  }
}
