import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createTestGlobalDb } from './helpers/test-db.js'
import { NonceCache, NONCE_TTL_SECONDS } from '../src/auth/nonce.js'
import { AuthVerifier } from '../src/auth/verifier.js'

function makeReq(
  headers: Record<string, string> = {},
  path = '/xrpc/com.atproto.repo.createRecord',
  query: Record<string, string> = {},
) {
  return { headers, originalUrl: path, path, query } as any
}

describe('AuthVerifier', () => {
  let globalDb: Kysely<GlobalDatabase>
  let nonceCache: NonceCache
  let verifier: AuthVerifier

  const SERVICE_DID = 'did:web:test.example.com'

  const fakeVerifyJwt = vi.fn()
  const fakeParseReqNsid = vi.fn()
  const mockIdResolver = {
    did: {
      resolveAtprotoData: vi.fn().mockResolvedValue({ signingKey: 'test-signing-key' }),
    },
    handle: {
      // 'group.example.com' resolves to the registered test group; anything
      // else resolves to nothing (an unknown handle).
      resolve: vi
        .fn()
        .mockImplementation(async (handle: string) =>
          handle === 'group.example.com' ? 'did:plc:testgroup' : undefined,
        ),
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
      SERVICE_DID,
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

  it('accepts a legacy aud=group token and flags legacyAud', async () => {
    const result = await verifier.verify(makeReq({ authorization: 'Bearer jwt' }))
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: 'did:plc:testgroup',
      legacyAud: true,
    })
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
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: 'did:plc:testgroup',
      legacyAud: true,
    })
  })

  it('enforces token lifetime in verifyServiceAuth', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      jti: 'jti-reg-long',
      iat: now,
      exp: now + NONCE_TTL_SECONDS + 60,
    })
    const regReq = makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.register')
    await expect(verifier.verifyServiceAuth(regReq)).rejects.toThrow(
      'Token lifetime exceeds nonce window',
    )
  })

  it('rejects missing iat in verifyServiceAuth', async () => {
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      jti: 'jti-reg-no-iat',
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    const regReq = makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.register')
    await expect(verifier.verifyServiceAuth(regReq)).rejects.toThrow(
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

  // --- New path (#27 fix): explicit `repo` + aud = service DID ---

  /** Mint a token whose aud is the service DID (the corrected meaning). */
  function mockServiceAudToken(jti = 'jti-new') {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti,
      iat: now,
      exp: now + 60,
    })
  }

  it('new path: querystring repo DID + aud=serviceDid resolves the group, not legacy', async () => {
    mockServiceAudToken()
    const result = await verifier.verify(
      makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
        repo: 'did:plc:testgroup',
      }),
    )
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: 'did:plc:testgroup',
      legacyAud: false,
    })
  })

  it('new path: querystring repo as a handle is resolved to the group DID', async () => {
    mockServiceAudToken()
    const result = await verifier.verify(
      makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
        repo: 'group.example.com',
      }),
    )
    expect(result.groupDid).toBe('did:plc:testgroup')
    expect(result.legacyAud).toBe(false)
    expect(mockIdResolver.handle.resolve).toHaveBeenCalledWith('group.example.com')
  })

  it('new path: querystring repo with aud=groupDid is a hard error (no half-migrated mix)', async () => {
    // A mid-migration caller that added `repo` but still sets aud=groupDid.
    // repo present forces the new-path aud check, which requires the service DID;
    // a group-DID aud is rejected rather than silently downgraded to legacy.
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:testgroup',
      jti: 'jti-both',
      iat: now,
      exp: now + 60,
    })
    // aud is the group, not the service DID — but repo is present, so the new
    // path applies and the aud check must be against the service DID.
    await expect(
      verifier.verify(
        makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
          repo: 'did:plc:testgroup',
        }),
      ),
    ).rejects.toThrow('jwt audience does not match service did')
  })

  it('new path: repo present but aud is neither service nor anything valid → rejected', async () => {
    mockServiceAudToken() // aud = service DID (correct)
    // wrong: repo names an unregistered group
    await expect(
      verifier.verify(
        makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
          repo: 'did:plc:unregistered',
        }),
      ),
    ).rejects.toThrow('Unknown group')
  })

  it('new path: aud=serviceDid with no repo (a procedure) returns no group, deferring to the handler', async () => {
    mockServiceAudToken()
    const result = await verifier.verify(
      makeReq({ authorization: 'Bearer jwt' }, '/xrpc/com.atproto.repo.createRecord'),
    )
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: undefined,
      legacyAud: false,
    })
  })

  // --- Service-proxying: aud carries the service-id fragment ---
  // Under AT Protocol service proxying the PDS may leave the `#fragment` on
  // `aud` (it is slated to stop stripping it). The verifier must accept the
  // service DID with our own fragment, but reject a different service's fragment.

  /** Mint a token whose aud is the service DID plus the given fragment. */
  function mockFragmentAudToken(fragment: string, jti = 'jti-frag') {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: `${SERVICE_DID}#${fragment}`,
      jti,
      iat: now,
      exp: now + 60,
    })
  }

  it('new path: aud=serviceDid#certified_group_service + querystring repo is accepted', async () => {
    mockFragmentAudToken('certified_group_service')
    const result = await verifier.verify(
      makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
        repo: 'did:plc:testgroup',
      }),
    )
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: 'did:plc:testgroup',
      legacyAud: false,
    })
  })

  it('new path: aud=serviceDid#certified_group_service with no repo (procedure) defers to the handler', async () => {
    mockFragmentAudToken('certified_group_service')
    const result = await verifier.verify(
      makeReq({ authorization: 'Bearer jwt' }, '/xrpc/com.atproto.repo.createRecord'),
    )
    expect(result).toEqual({
      iss: 'did:plc:caller',
      groupDid: undefined,
      legacyAud: false,
    })
  })

  it('rejects aud carrying a DIFFERENT service fragment (not this service)', async () => {
    mockFragmentAudToken('some_other_service')
    // repo present → new-path aud check applies; a foreign fragment is not us.
    await expect(
      verifier.verify(
        makeReq({ authorization: 'Bearer jwt' }, '/xrpc/app.certified.group.member.list', {
          repo: 'did:plc:testgroup',
        }),
      ),
    ).rejects.toThrow('jwt audience does not match service did')
  })

  it('resolveRepoToGroup rejects an unknown handle', async () => {
    await expect(verifier.resolveRepoToGroup('nope.example.com')).rejects.toThrow(
      'Could not resolve repo to a DID',
    )
  })

  it('resolveRepoToGroup rejects a DID that is not a registered group', async () => {
    await expect(verifier.resolveRepoToGroup('did:plc:unregistered')).rejects.toThrow(
      'Unknown group',
    )
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
