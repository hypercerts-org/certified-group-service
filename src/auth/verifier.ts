import { IdResolver } from '@atproto/identity'
import { AuthRequiredError, verifyJwt as defaultVerifyJwt, parseReqNsid as defaultParseReqNsid, type AuthVerifier as XrpcAuthVerifier } from '@atproto/xrpc-server'
import type { Kysely } from 'kysely'
import type { Request } from 'express'
import type { GlobalDatabase } from '../db/schema.js'
import { NonceCache } from './nonce.js'

export interface GroupAuthCredentials {
  callerDid: string
  groupDid: string
}
export type GroupAuthResult = { credentials: GroupAuthCredentials }

const ACCEPTED_NSIDS = new Set([
  'com.atproto.repo.createRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.uploadBlob',
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
    verifyJwtFn?: typeof defaultVerifyJwt,
    parseReqNsidFn?: typeof defaultParseReqNsid,
  ) {
    this.verifyJwtFn = verifyJwtFn ?? defaultVerifyJwt
    this.parseReqNsidFn = parseReqNsidFn ?? defaultParseReqNsid
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

  xrpcAuth(): XrpcAuthVerifier {
    return async ({ req }) => {
      const { iss, aud } = await this.verify(req)
      return {
        credentials: { callerDid: iss, groupDid: aud },
      }
    }
  }
}
