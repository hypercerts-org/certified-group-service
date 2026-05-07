import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createTestGlobalDb } from './helpers/test-db.js'
import { NonceCache, NONCE_TTL_SECONDS } from '../src/auth/nonce.js'
import { AuthVerifier } from '../src/auth/verifier.js'

function makeReq(
  headers: Record<string, string> = {},
  path = '/xrpc/com.atproto.repo.createRecord',
) {
  return { headers, originalUrl: path, path } as any
}

describe('AuthVerifier', () => {
  let globalDb: Kysely<GlobalDatabase>
  let nonceCache: NonceCache
  let verifier: AuthVerifier

  const fakeVerifyJwt = vi.fn()
  const fakeParseReqNsid = vi.fn()
  const mockIdResolver = {
    did: {
      resolveAtprotoData: vi.fn().mockResolvedValue({ signingKey: 'test-signing-key' }),
    },
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    const testGlobal = await createTestGlobalDb()
    globalDb = testGlobal.db
    await globalDb
      .insertInto('groups')
      .values({
        did: 'did:plc:testgroup',
        pds_url: 'https://pds.example.com',
        encrypted_app_password: 'encrypted',
      })
      .execute()
    nonceCache = new NonceCache(globalDb)
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      'did:web:test.example.com',
      fakeVerifyJwt,
      fakeParseReqNsid,
    )

    // Default mocks
    fakeParseReqNsid.mockReturnValue('com.atproto.repo.createRecord')
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-unique',
      iat: now,
      exp: now + 60,
    })
  })

  it('rejects missing Authorization header', async () => {
    await expect(verifier.verify(makeReq({}))).rejects.toThrow('Missing auth token')
  })

  it('rejects non-Bearer token', async () => {
    await expect(verifier.verify(makeReq({ authorization: 'Basic abc' }))).rejects.toThrow(
      'Missing auth token',
    )
  })

  it('rejects invalid audience (group not in DB)', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:user',
      aud: 'did:plc:unknown',
      jti: 'jti-1',
      iat: now,
      exp: now + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Invalid audience',
    )
  })

  it('rejects missing aud in JWT', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:user',
      aud: undefined,
      jti: 'jti-1',
      iat: now,
      exp: now + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Invalid audience',
    )
  })

  it('rejects missing jti', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:user',
      aud: 'did:plc:testgroup',
      jti: undefined,
      iat: now,
      exp: now + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Missing jti in service auth token',
    )
  })

  it('rejects replayed token (duplicate jti)', async () => {
    await nonceCache.checkAndStore('jti-replayed')
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:user',
      aud: 'did:plc:testgroup',
      jti: 'jti-replayed',
      iat: now,
      exp: now + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Replayed token',
    )
  })

  it('accepts valid token and returns iss/aud', async () => {
    const result = await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))
    expect(result).toEqual({ iss: 'did:plc:caller', aud: 'did:plc:testgroup' })
  })

  it('rejects token where exp - iat exceeds nonce TTL', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-long-lived',
      iat: now,
      exp: now + NONCE_TTL_SECONDS + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Token lifetime exceeds nonce window',
    )
  })

  it('rejects token with missing iat', async () => {
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-no-iat',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Missing iat in service auth token',
    )
  })

  it('accepts token where exp - iat is within nonce TTL', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-short-lived',
      iat: now,
      exp: now + NONCE_TTL_SECONDS,
    })
    const result = await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))
    expect(result).toEqual({ iss: 'did:plc:caller', aud: 'did:plc:testgroup' })
  })

  it('enforces token lifetime in verifyRegistration', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      jti: 'jti-reg-long',
      iat: now,
      exp: now + NONCE_TTL_SECONDS + 60,
    })
    const regReq = makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.register')
    await expect(verifier.verifyRegistration(regReq)).rejects.toThrow(
      'Token lifetime exceeds nonce window',
    )
  })

  it('rejects missing iat in verifyRegistration', async () => {
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      jti: 'jti-reg-no-iat',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const regReq = makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.register')
    await expect(verifier.verifyRegistration(regReq)).rejects.toThrow(
      'Missing iat in service auth token',
    )
  })

  it('passes correct getSigningKey callback to verifyJwt', async () => {
    await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))

    expect(fakeVerifyJwt).toHaveBeenCalled()
    const getSigningKey = fakeVerifyJwt.mock.calls[0][3]
    const key = await getSigningKey('did:plc:caller', false)
    expect(key).toBe('test-signing-key')
    expect(mockIdResolver.did.resolveAtprotoData).toHaveBeenCalledWith('did:plc:caller', false)
  })
})

describe('verifyServiceAuth', () => {
  let globalDb: Kysely<GlobalDatabase>
  let nonceCache: NonceCache
  let verifier: AuthVerifier

  const fakeVerifyJwt = vi.fn()
  const fakeParseReqNsid = vi.fn()
  const mockIdResolver = {
    did: {
      resolveAtprotoData: vi.fn().mockResolvedValue({ signingKey: 'test-signing-key' }),
    },
  }

  const SERVICE_DID = 'did:web:test.example.com'

  beforeEach(async () => {
    vi.clearAllMocks()
    const testGlobal = await createTestGlobalDb()
    globalDb = testGlobal.db
    nonceCache = new NonceCache(globalDb)
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      SERVICE_DID,
      fakeVerifyJwt,
      fakeParseReqNsid,
    )

    fakeParseReqNsid.mockReturnValue('app.certified.groups.membership.list')
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: 'jti-unique',
      iat: now,
      exp: now + 60,
    })
  })

  it('rejects missing Authorization header', async () => {
    const req = makeReq({}, '/xrpc/app.certified.groups.membership.list')
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow('Missing auth token')
  })

  it('rejects non-Bearer token', async () => {
    const req = makeReq(
      { authorization: 'Basic abc' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow('Missing auth token')
  })

  it('rejects token lifetime exceeding nonce TTL', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: 'jti-long',
      iat: now,
      exp: now + NONCE_TTL_SECONDS + 60,
    })
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow(
      'Token lifetime exceeds nonce window',
    )
  })

  it('rejects missing iat', async () => {
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: 'jti-no-iat',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow(
      'Missing iat in service auth token',
    )
  })

  it('rejects missing jti', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: undefined,
      iat: now,
      exp: now + 60,
    })
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow(
      'Missing jti in service auth token',
    )
  })

  it('rejects replayed token (duplicate jti)', async () => {
    await nonceCache.checkAndStore('jti-replayed')
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: 'jti-replayed',
      iat: now,
      exp: now + 60,
    })
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow('Replayed token')
  })

  it('valid token returns only iss (no aud)', async () => {
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    const result = await verifier.verifyServiceAuth(req)
    expect(result).toEqual({ iss: 'did:plc:caller' })
  })

  it('passes serviceDid as audience to verifyJwt', async () => {
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await verifier.verifyServiceAuth(req)
    expect(fakeVerifyJwt).toHaveBeenCalled()
    expect(fakeVerifyJwt.mock.calls[0][1]).toBe(SERVICE_DID)
  })

  it('passes parsed NSID to verifyJwt', async () => {
    fakeParseReqNsid.mockReturnValue('app.certified.groups.membership.list')
    const req = makeReq(
      { authorization: 'Bearer jwt' },
      '/xrpc/app.certified.groups.membership.list',
    )
    await verifier.verifyServiceAuth(req)
    expect(fakeVerifyJwt.mock.calls[0][2]).toBe('app.certified.groups.membership.list')
  })
})

describe('AuthVerifier auth-failure logging', () => {
  let globalDb: Kysely<GlobalDatabase>
  let nonceCache: NonceCache
  let verifier: AuthVerifier
  let logger: { warn: ReturnType<typeof vi.fn> }

  const fakeVerifyJwt = vi.fn()
  const fakeParseReqNsid = vi.fn()
  const mockIdResolver = {
    did: {
      resolveAtprotoData: vi.fn().mockResolvedValue({ signingKey: 'test-signing-key' }),
    },
  }

  // Encode a fake JWT (header+payload only — signature is irrelevant for the
  // log decoder, which never verifies it).
  function encodeJwt(header: object, payload: object): string {
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url')
    return `${b64(header)}.${b64(payload)}.sig`
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    const testGlobal = await createTestGlobalDb()
    globalDb = testGlobal.db
    await globalDb.insertInto('groups').values({
      did: 'did:plc:testgroup',
      pds_url: 'https://pds.example.com',
      encrypted_app_password: 'encrypted',
    }).execute()
    nonceCache = new NonceCache(globalDb)
    logger = { warn: vi.fn() }
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      'did:web:test.example.com',
      fakeVerifyJwt,
      fakeParseReqNsid,
      logger as any,
    )
    fakeParseReqNsid.mockReturnValue('com.atproto.repo.putRecord')
  })

  it('logs decoded JWT header+payload on Invalid audience without leaking signature', async () => {
    const now = Math.floor(Date.now() / 1000)
    const jwtPayload = { iss: 'did:plc:caller', aud: 'did:plc:wronggroup', jti: 'jti-x', iat: now, exp: now + 60 }
    const jwtHeader = { alg: 'ES256K', typ: 'JWT' }
    const jwt = encodeJwt(jwtHeader, jwtPayload)
    fakeVerifyJwt.mockResolvedValue(jwtPayload)

    await expect(verifier.verify(makeReq({ authorization: `Bearer ${jwt}` }))).rejects.toThrow('Invalid audience')

    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [logCtx, logMsg] = logger.warn.mock.calls[0]
    expect(logMsg).toBe('Auth verification failed')
    expect(logCtx.reason).toBe('Invalid audience')
    expect(logCtx.nsid).toBe('com.atproto.repo.putRecord')
    expect(logCtx.jwt).toEqual({ header: jwtHeader, payload: jwtPayload })
    // Signature is the third dot-segment; the logged jwt object must not
    // contain it under any key.
    expect(JSON.stringify(logCtx.jwt)).not.toContain('sig')
  })

  it('logs reason for missing Authorization header without a JWT field', async () => {
    await expect(verifier.verify(makeReq({}))).rejects.toThrow('Missing auth token')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [logCtx] = logger.warn.mock.calls[0]
    expect(logCtx.reason).toBe('Missing auth token')
    expect(logCtx.jwt).toBeUndefined()
  })

  it('does not log on successful auth', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({ iss: 'did:plc:caller', aud: 'did:plc:testgroup', jti: 'jti-ok', iat: now, exp: now + 60 })
    await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs when verifyJwt itself throws (bad signature/lxm/exp)', async () => {
    fakeVerifyJwt.mockRejectedValue(new Error('jwt signature invalid'))
    const jwt = encodeJwt({ alg: 'ES256K' }, { iss: 'did:plc:caller', aud: 'did:plc:testgroup' })
    await expect(verifier.verify(makeReq({ authorization: `Bearer ${jwt}` }))).rejects.toThrow('jwt signature invalid')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [logCtx] = logger.warn.mock.calls[0]
    expect(logCtx.reason).toBe('verifyJwt threw')
    expect(logCtx.error).toBe('jwt signature invalid')
    expect(logCtx.jwt).toBeTruthy()
  })
})
