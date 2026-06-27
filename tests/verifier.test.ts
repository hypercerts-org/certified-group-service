import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../src/db/schema.js'
import { createTestGlobalDb } from './helpers/test-db.js'
import { NonceCache, NONCE_TTL_SECONDS } from '../src/auth/nonce.js'
import { AuthVerifier } from '../src/auth/verifier.js'
import type { GroupAuthResult } from '../src/auth/verifier.js'
import { GroupDbPool } from '../src/db/group-db-pool.js'
import { generateApiKey } from '../src/auth/api-key.js'

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
  let groupDbs: GroupDbPool
  let groupDbsDir: string

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
    groupDbsDir = mkdtempSync(join(tmpdir(), 'verifier-test-'))
    groupDbs = new GroupDbPool(groupDbsDir)
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      SERVICE_DID,
      groupDbs,
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

  afterEach(async () => {
    await groupDbs.destroyAll()
    rmSync(groupDbsDir, { recursive: true, force: true })
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

  describe('X-API-Key path (xrpcAuth)', () => {
    const GROUP = 'did:plc:testgroup'
    const SCOPES = ['rpc:app.certified.group.member.list']

    // Seed a key into the (migrated) per-group DB and return its plaintext.
    async function seedKey(
      overrides: { revoked?: boolean; createdBy?: string; scopes?: string[] } = {},
    ) {
      await groupDbs.migrateGroup(GROUP)
      const db = groupDbs.get(GROUP)
      const key = generateApiKey()
      await db
        .insertInto('group_api_keys')
        .values({
          key_ref: key.keyRef,
          key_hash: key.hash,
          name: 'test key',
          scopes: JSON.stringify(overrides.scopes ?? SCOPES),
          created_by: overrides.createdBy ?? 'did:plc:owner',
          revoked_at: overrides.revoked ? '2020-01-01 00:00:00' : null,
        })
        .execute()
      return key
    }

    // `repo: null` explicitly omits the param (an explicit `undefined` would
    // trigger the default, so null is the "no repo" sentinel here).
    function apiKeyReq(apiKey: string, repo: string | null = GROUP) {
      return makeReq(
        { 'x-api-key': apiKey },
        '/xrpc/app.certified.group.member.list',
        repo === null ? {} : { repo },
      )
    }

    // xrpcAuth()'s MethodAuthVerifier return is a union (success | error
    // shape); narrow it to the success result for assertions.
    async function runAuth(req: unknown): Promise<GroupAuthResult> {
      const auth = verifier.xrpcAuth()
      return (await auth({ req } as never)) as GroupAuthResult
    }

    it('authenticates a valid key and returns apiKey credentials with scopes', async () => {
      const key = await seedKey()
      const { credentials } = await runAuth(apiKeyReq(key.plaintext))
      expect(credentials).toMatchObject({
        callerDid: 'did:plc:owner', // issuing member DID
        groupDid: GROUP,
        legacyAud: false,
        authKind: 'apiKey',
        apiKeyRef: key.keyRef,
      })
      expect(credentials.scopes).toEqual(SCOPES)
      // verifyJwt must NOT be consulted on the key path.
      expect(fakeVerifyJwt).not.toHaveBeenCalled()
    })

    it('touches last_used_at on a successful key auth', async () => {
      const key = await seedKey()
      const auth = verifier.xrpcAuth()
      await auth({ req: apiKeyReq(key.plaintext) } as any)
      const row = await groupDbs
        .get(GROUP)
        .selectFrom('group_api_keys')
        .where('key_ref', '=', key.keyRef)
        .select('last_used_at')
        .executeTakeFirst()
      expect(row?.last_used_at).toBeTruthy()
    })

    it('rejects a malformed key', async () => {
      const auth = verifier.xrpcAuth()
      await expect(auth({ req: apiKeyReq('not-a-key') } as any)).rejects.toThrow(
        'Malformed API key',
      )
    })

    it('rejects when repo is absent (no group to target)', async () => {
      const key = await seedKey()
      const auth = verifier.xrpcAuth()
      await expect(auth({ req: apiKeyReq(key.plaintext, null) } as any)).rejects.toThrow(
        'Missing repo for API-key request',
      )
    })

    it('rejects a revoked key', async () => {
      const key = await seedKey({ revoked: true })
      const auth = verifier.xrpcAuth()
      await expect(auth({ req: apiKeyReq(key.plaintext) } as any)).rejects.toThrow(
        'Invalid API key',
      )
    })

    it('rejects a wrong secret for an existing keyRef', async () => {
      const key = await seedKey()
      const tampered = `${key.plaintext}tamper`
      const auth = verifier.xrpcAuth()
      await expect(auth({ req: apiKeyReq(tampered) } as any)).rejects.toThrow('Invalid API key')
    })

    it('rejects an unknown keyRef (no oracle vs wrong group)', async () => {
      await seedKey() // group has a key, but we present a different one
      const other = generateApiKey()
      const auth = verifier.xrpcAuth()
      await expect(auth({ req: apiKeyReq(other.plaintext) } as any)).rejects.toThrow(
        'Invalid API key',
      )
    })

    it('falls through to the JWT path when no X-API-Key header is present', async () => {
      // Default fakeVerifyJwt mock resolves a legacy-aud JWT for the test group.
      const { credentials } = await runAuth(makeReq({ authorization: 'Bearer jwt' }))
      expect(credentials.authKind).toBe('jwt')
      expect(fakeVerifyJwt).toHaveBeenCalled()
    })
  })
})

describe('verifyServiceAuth', () => {
  let globalDb: Kysely<GlobalDatabase>
  let nonceCache: NonceCache
  let verifier: AuthVerifier
  let groupDbs: GroupDbPool
  let groupDbsDir: string

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
    groupDbsDir = mkdtempSync(join(tmpdir(), 'verifier-svc-test-'))
    groupDbs = new GroupDbPool(groupDbsDir)
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      SERVICE_DID,
      groupDbs,
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

  afterEach(async () => {
    await groupDbs.destroyAll()
    rmSync(groupDbsDir, { recursive: true, force: true })
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
  let groupDbs: GroupDbPool
  let groupDbsDir: string
  let warn: ReturnType<typeof vi.fn>

  const SERVICE_DID = 'did:web:test.example.com'
  const GROUP = 'did:plc:testgroup'

  const fakeVerifyJwt = vi.fn()
  const fakeParseReqNsid = vi.fn()
  const mockIdResolver = {
    did: { resolveAtprotoData: vi.fn().mockResolvedValue({ signingKey: 'test-signing-key' }) },
    handle: { resolve: vi.fn().mockResolvedValue(undefined) },
  }

  // A JWT-shaped token with a recognizable signature segment so we can assert
  // it never leaks into a log record. base64url("{}") === "e30".
  const SIGNATURE = 'THIS_SIGNATURE_MUST_NOT_BE_LOGGED'
  const JWT = `e30.e30.${SIGNATURE}`

  beforeEach(async () => {
    vi.clearAllMocks()
    const testGlobal = await createTestGlobalDb()
    globalDb = testGlobal.db
    await globalDb
      .insertInto('groups')
      .values({
        did: GROUP,
        pds_url: 'https://pds.example.com',
        encrypted_app_password: 'encrypted',
      })
      .execute()
    nonceCache = new NonceCache(globalDb)
    groupDbsDir = mkdtempSync(join(tmpdir(), 'verifier-log-test-'))
    groupDbs = new GroupDbPool(groupDbsDir)
    warn = vi.fn()
    verifier = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      SERVICE_DID,
      groupDbs,
      fakeVerifyJwt,
      fakeParseReqNsid,
      { warn } as any,
    )
    fakeParseReqNsid.mockReturnValue('com.atproto.repo.createRecord')
    const now = Math.floor(Date.now() / 1000)
    // Default: a valid legacy-aud JWT for the test group.
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: GROUP,
      jti: 'jti-unique',
      iat: now,
      exp: now + 60,
    })
  })

  afterEach(async () => {
    await groupDbs.destroyAll()
    rmSync(groupDbsDir, { recursive: true, force: true })
  })

  it('logs the decoded JWT header+payload on Invalid audience, never the signature', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:not-a-group', // unknown group → Invalid audience
      jti: 'jti-bad-aud',
      iat: now,
      exp: now + 60,
    })
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    await expect(verifier.verify(req)).rejects.toThrow('Invalid audience')

    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, msg] = warn.mock.calls[0]
    expect(msg).toBe('Auth verification failed')
    expect(fields.reason).toBe('Invalid audience')
    // Header+payload are decoded for diagnosis; both are `{}` here.
    expect(fields.jwt).toEqual({ header: {}, payload: {} })
    // The raw token (and its signature) must never appear anywhere in the record.
    expect(JSON.stringify(fields)).not.toContain(SIGNATURE)
  })

  it('logs missing Authorization without a jwt field', async () => {
    const req = makeReq({}, '/xrpc/com.atproto.repo.createRecord')
    await expect(verifier.verify(req)).rejects.toThrow('Missing auth token')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('Missing auth token')
    expect(fields).not.toHaveProperty('jwt')
    expect(fields.path).toBe('/xrpc/com.atproto.repo.createRecord')
  })

  it('logs nothing on the success path', async () => {
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    await verifier.verify(req)
    expect(warn).not.toHaveBeenCalled()
  })

  it('wraps and logs a throwing verifyJwt', async () => {
    fakeVerifyJwt.mockRejectedValue(new Error('jwt signature invalid'))
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    await expect(verifier.verify(req)).rejects.toThrow('jwt signature invalid')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('verifyJwt threw')
    expect(fields.error).toBe('jwt signature invalid')
    expect(JSON.stringify(fields)).not.toContain(SIGNATURE)
  })

  it('logs an API-key failure with keyRef and reason, never the raw key', async () => {
    const key = generateApiKey()
    const req = makeReq(
      { 'x-api-key': key.plaintext },
      '/xrpc/app.certified.group.member.list',
      { repo: GROUP }, // resolves, but no matching key row → Invalid API key
    )
    await groupDbs.migrateGroup(GROUP)
    await expect(verifier.verifyApiKey(req, key.plaintext)).rejects.toThrow('Invalid API key')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('Invalid API key')
    expect(fields.authKind).toBe('apiKey')
    expect(fields.keyRef).toBe(key.keyRef)
    // The secret half of the key must never be logged.
    expect(JSON.stringify(fields)).not.toContain(key.plaintext)
  })

  it('does not log when no logger is configured', async () => {
    const noLogger = new AuthVerifier(
      mockIdResolver as any,
      nonceCache,
      globalDb,
      SERVICE_DID,
      groupDbs,
      fakeVerifyJwt,
      fakeParseReqNsid,
    )
    const req = makeReq({}, '/xrpc/com.atproto.repo.createRecord')
    // No logger → no throw from the logging path, just the auth error.
    await expect(noLogger.verify(req)).rejects.toThrow('Missing auth token')
    expect(warn).not.toHaveBeenCalled()
  })

  it('wraps and logs a throwing verifyJwt on the service-auth path', async () => {
    fakeVerifyJwt.mockRejectedValue(new Error('service jwt signature invalid'))
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    await expect(verifier.verifyServiceAuth(req)).rejects.toThrow('service jwt signature invalid')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('verifyJwt threw')
    expect(fields.error).toBe('service jwt signature invalid')
    expect(JSON.stringify(fields)).not.toContain(SIGNATURE)
  })

  it('xrpcServiceAuth returns the caller DID on a valid service-auth token', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: SERVICE_DID,
      jti: 'jti-service-ok',
      iat: now,
      exp: now + 60,
    })
    const auth = verifier.xrpcServiceAuth()
    const result = await auth({ req: makeReq({ authorization: `Bearer ${JWT}` }) } as any)
    expect(result).toEqual({ credentials: { callerDid: 'did:plc:caller' } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs Corrupt API-key scopes when the stored scopes are not a JSON array', async () => {
    await groupDbs.migrateGroup(GROUP)
    const key = generateApiKey()
    await groupDbs
      .get(GROUP)
      .insertInto('group_api_keys')
      .values({
        key_ref: key.keyRef,
        key_hash: key.hash,
        name: 'corrupt key',
        scopes: '{"not":"an array"}', // valid JSON, but not an array
        created_by: 'did:plc:owner',
        revoked_at: null,
      })
      .execute()
    const req = makeReq({ 'x-api-key': key.plaintext }, '/xrpc/app.certified.group.member.list', {
      repo: GROUP,
    })
    await expect(verifier.verifyApiKey(req, key.plaintext)).rejects.toThrow(
      'Corrupt API-key scopes',
    )
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('Corrupt API-key scopes')
    expect(fields.keyRef).toBe(key.keyRef)
  })

  it('logs a non-Error throw from verifyJwt by stringifying it', async () => {
    // verifyJwt rejecting with a non-Error value exercises the String(err) branch.
    fakeVerifyJwt.mockRejectedValue('plain string failure')
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    await expect(verifier.verify(req)).rejects.toBe('plain string failure')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('verifyJwt threw')
    expect(fields.error).toBe('plain string failure')
  })

  it('logs when an API-key request names a repo that is not a known group', async () => {
    const key = generateApiKey()
    const req = makeReq({ 'x-api-key': key.plaintext }, '/xrpc/app.certified.group.member.list', {
      repo: 'did:plc:not-a-group',
    })
    await expect(verifier.verifyApiKey(req, key.plaintext)).rejects.toThrow('Unknown group')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('repo did not resolve to a known group')
    expect(fields.keyRef).toBe(key.keyRef)
    expect(fields.repoParam).toBe('did:plc:not-a-group')
  })

  it('logs jwt: null when the token segments cannot be decoded', async () => {
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockResolvedValue({
      iss: 'did:plc:caller',
      aud: 'did:plc:not-a-group', // unknown group → Invalid audience
      jti: 'jti-undecodable',
      iat: now,
      exp: now + 60,
    })
    // A header.payload.sig shape whose payload segment is not valid base64 JSON,
    // so decodeJwtForLog returns null rather than an object.
    const req = makeReq({ authorization: `Bearer aaa.!!!notbase64!!!.${SIGNATURE}` })
    await expect(verifier.verify(req)).rejects.toThrow('Invalid audience')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields] = warn.mock.calls[0]
    expect(fields.reason).toBe('Invalid audience')
    expect(fields.jwt).toBeNull()
    expect(JSON.stringify(fields)).not.toContain(SIGNATURE)
  })

  it('verifyServiceAuth resolves the signing key via the DID resolver', async () => {
    // Drive verifyJwt's key-resolver callback so the resolver closure executes.
    const now = Math.floor(Date.now() / 1000)
    fakeVerifyJwt.mockImplementation(async (_jwt, _aud, _nsid, getKey) => {
      await getKey('did:plc:caller', false)
      return {
        iss: 'did:plc:caller',
        aud: SERVICE_DID,
        jti: 'jti-resolver',
        iat: now,
        exp: now + 60,
      }
    })
    const req = makeReq({ authorization: `Bearer ${JWT}` })
    const result = await verifier.verifyServiceAuth(req)
    expect(result).toEqual({ iss: 'did:plc:caller' })
    expect(mockIdResolver.did.resolveAtprotoData).toHaveBeenCalledWith('did:plc:caller', false)
  })
})

describe('AuthVerifier.xrpcAdminAuth', () => {
  const SERVICE_DID = 'did:web:test.example.com'
  const ADMIN_PASS = 'super-secret-admin'

  // Admin (Basic) auth needs no DB, nonce cache, or resolver — pass stubs.
  const build = (adminPassword?: string) =>
    new AuthVerifier(
      {} as any,
      {} as any,
      {} as any,
      SERVICE_DID,
      {} as any,
      undefined,
      undefined,
      undefined,
      adminPassword,
    )

  const basic = (user: string, pass: string): string =>
    'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

  // xrpcAdminAuth's verifier is synchronous (Basic auth needs no I/O), so a
  // rejection surfaces as a synchronous throw — assert with expect(fn).toThrow.
  const run = (verifier: AuthVerifier, headers: Record<string, string>) => () =>
    verifier.xrpcAdminAuth()({ req: makeReq(headers) } as any)

  it('accepts admin:<password> when configured', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, { authorization: basic('admin', ADMIN_PASS) })()).toEqual({
      credentials: { type: 'admin' },
    })
  })

  it('rejects every request when no admin password is configured', () => {
    const v = build(undefined)
    expect(run(v, { authorization: basic('admin', 'anything') })).toThrow(
      'Admin endpoints are disabled',
    )
  })

  it('rejects a missing Authorization header', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, {})).toThrow('Missing admin credentials')
  })

  it('rejects a non-Basic scheme', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, { authorization: 'Bearer xyz' })).toThrow('Missing admin')
  })

  it('rejects the wrong password', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, { authorization: basic('admin', 'nope') })).toThrow('Invalid admin credentials')
  })

  it('rejects the wrong username', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, { authorization: basic('root', ADMIN_PASS) })).toThrow(
      'Invalid admin credentials',
    )
  })

  it('rejects credentials with no colon as malformed', () => {
    const v = build(ADMIN_PASS)
    const header = 'Basic ' + Buffer.from('adminonly').toString('base64')
    expect(run(v, { authorization: header })).toThrow('Malformed admin credentials')
  })

  it('rejects a token with junk appended (lenient base64 decode)', () => {
    const v = build(ADMIN_PASS)
    // Buffer.from(_, 'base64') would otherwise drop the trailing junk and
    // decode this to the same valid `admin:<pass>` credentials.
    const good = Buffer.from(`admin:${ADMIN_PASS}`).toString('base64')
    expect(run(v, { authorization: `Basic ${good}!!!!` })).toThrow('Malformed admin credentials')
  })

  it('rejects a non-base64 token', () => {
    const v = build(ADMIN_PASS)
    expect(run(v, { authorization: 'Basic @@@not-base64@@@' })).toThrow(
      'Malformed admin credentials',
    )
  })
})
