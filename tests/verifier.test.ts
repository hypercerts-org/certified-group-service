import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createTestGlobalDb } from './helpers/test-db.js'
import { NonceCache } from '../src/auth/nonce.js'
import { AuthVerifier } from '../src/auth/verifier.js'

function makeReq(headers: Record<string, string> = {}, path = '/xrpc/com.atproto.repo.createRecord') {
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
    globalDb = await createTestGlobalDb()
    await globalDb.insertInto('groups').values({ did: 'did:plc:testgroup' }).execute()
    nonceCache = new NonceCache(globalDb)
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      fakeVerifyJwt,
      fakeParseReqNsid,
    )

    // Default mocks
    fakeParseReqNsid.mockReturnValue('com.atproto.repo.createRecord')
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-unique',
    })
  })

  it('rejects missing Authorization header', async () => {
    await expect(verifier.verify(makeReq({}))).rejects.toThrow('Missing auth token')
  })

  it('rejects non-Bearer token', async () => {
    await expect(verifier.verify(makeReq({ authorization: 'Basic abc' }))).rejects.toThrow('Missing auth token')
  })

  it('rejects unsupported NSID', async () => {
    fakeParseReqNsid.mockReturnValue('com.atproto.repo.getRecord')
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Unsupported NSID: com.atproto.repo.getRecord',
    )
  })

  it('rejects invalid audience (group not in DB)', async () => {
    fakeVerifyJwt.mockResolvedValue({ iss: 'did:plc:user', aud: 'did:plc:unknown', jti: 'jti-1' })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow('Invalid audience')
  })

  it('rejects missing aud in JWT', async () => {
    fakeVerifyJwt.mockResolvedValue({ iss: 'did:plc:user', aud: undefined, jti: 'jti-1' })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow('Invalid audience')
  })

  it('rejects missing jti', async () => {
    fakeVerifyJwt.mockResolvedValue({ iss: 'did:plc:user', aud: 'did:plc:testgroup', jti: undefined })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow(
      'Missing jti in service auth token',
    )
  })

  it('rejects replayed token (duplicate jti)', async () => {
    await nonceCache.checkAndStore('jti-replayed')
    fakeVerifyJwt.mockResolvedValue({ iss: 'did:plc:user', aud: 'did:plc:testgroup', jti: 'jti-replayed' })
    await expect(verifier.verify(makeReq({ authorization: 'Bearer jwt' }))).rejects.toThrow('Replayed token')
  })

  it('accepts valid token and returns iss/aud', async () => {
    const result = await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))
    expect(result).toEqual({ iss: 'did:plc:caller', aud: 'did:plc:testgroup' })
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
