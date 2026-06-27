/**
 * Unit tests for PermissionSetResolver — the Lexicon-resolution chain that turns
 * an NSID into a LexiconPermissionSet (NSID → _lexicon DNS TXT → authority DID →
 * PDS → com.atproto.lexicon.schema record). DNS and the record fetch are
 * injected, so no network is touched.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  PermissionSetResolver,
  PermissionSetResolutionError,
} from '../src/auth/permission-set-resolver.js'

// Mock @atproto/api so the DEFAULT record fetcher (which constructs an AtpAgent
// and calls getRecord) can be exercised without a real PDS.
const mockGetRecord = vi.fn()
vi.mock('@atproto/api', () => ({
  AtpAgent: class {
    com = { atproto: { repo: { getRecord: mockGetRecord } } }
    constructor(_opts: unknown) {}
  },
}))

const AUTHORITY_DID = 'did:web:permissions.hypercerts.org'
const PDS_URL = 'https://pds.example.com'
const NSID = 'org.hypercerts.authWrite'

const PERMISSION_SET = {
  lexicon: 1,
  id: NSID,
  defs: {
    main: {
      type: 'permission-set',
      title: 'Manage your Hypercerts data',
      permissions: [
        {
          type: 'permission',
          resource: 'repo',
          collection: ['org.hypercerts.claim.activity'],
          action: ['create', 'update', 'delete'],
        },
      ],
    },
  },
}

/** A resolver wired with stubbed DNS + record fetch + a fake DID→PDS resolver. */
function makeResolver(opts: {
  txt?: string[][]
  txtThrows?: boolean
  record?: unknown
  recordThrows?: boolean
  pds?: string | undefined
  pdsThrows?: boolean
  ttlMs?: number
  now?: () => number
}) {
  const idResolver = {
    did: {
      resolveAtprotoData: vi.fn(async () => {
        if (opts.pdsThrows) throw new Error('DID not found')
        return { pds: opts.pds ?? PDS_URL }
      }),
    },
  } as any
  const txtResolver = vi.fn(async () => {
    if (opts.txtThrows) throw new Error('ENOTFOUND')
    return opts.txt ?? [[`did=${AUTHORITY_DID}`]]
  })
  const fetchSchemaRecord = vi.fn(async () => {
    if (opts.recordThrows) throw new Error('record not found')
    return opts.record ?? PERMISSION_SET
  })
  const resolver = new PermissionSetResolver(idResolver, {
    txtResolver,
    fetchSchemaRecord,
    ttlMs: opts.ttlMs,
    now: opts.now,
  })
  return { resolver, idResolver, txtResolver, fetchSchemaRecord }
}

describe('PermissionSetResolver', () => {
  it('resolves NSID → permission set via the full chain', async () => {
    const { resolver, txtResolver, idResolver, fetchSchemaRecord } = makeResolver({})
    const set = await resolver.resolve(NSID)

    expect(set.type).toBe('permission-set')
    expect(set.permissions).toHaveLength(1)
    // DNS query is on _lexicon.<authority> (authority = reversed domain).
    expect(txtResolver).toHaveBeenCalledWith('_lexicon.hypercerts.org')
    expect(idResolver.did.resolveAtprotoData).toHaveBeenCalledWith(AUTHORITY_DID)
    // rkey is the full NSID.
    expect(fetchSchemaRecord).toHaveBeenCalledWith(PDS_URL, AUTHORITY_DID, NSID)
  })

  it('caches a resolved set (second call does no DNS/fetch)', async () => {
    const { resolver, txtResolver, fetchSchemaRecord } = makeResolver({
      ttlMs: 60_000,
      now: () => 1000,
    })
    await resolver.resolve(NSID)
    await resolver.resolve(NSID)
    expect(txtResolver).toHaveBeenCalledTimes(1)
    expect(fetchSchemaRecord).toHaveBeenCalledTimes(1)
  })

  it('re-resolves after the cache TTL expires', async () => {
    let t = 1000
    const { resolver, txtResolver } = makeResolver({ ttlMs: 100, now: () => t })
    await resolver.resolve(NSID)
    t += 200 // past TTL
    await resolver.resolve(NSID)
    expect(txtResolver).toHaveBeenCalledTimes(2)
  })

  it('rejects a malformed NSID', async () => {
    const { resolver } = makeResolver({})
    await expect(resolver.resolve('not-an-nsid')).rejects.toBeInstanceOf(
      PermissionSetResolutionError,
    )
  })

  it('rejects when there is no _lexicon TXT record', async () => {
    const { resolver } = makeResolver({ txtThrows: true })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/no _lexicon TXT/)
  })

  it('rejects ambiguous authority (more than one did= record)', async () => {
    const { resolver } = makeResolver({
      txt: [[`did=${AUTHORITY_DID}`], ['did=did:web:other.example']],
    })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/exactly one did=/)
  })

  it('rejects a non-https PDS endpoint', async () => {
    const { resolver } = makeResolver({ pds: 'http://insecure.example' })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/no https PDS/)
  })

  it('rejects a record whose main def is not a permission-set', async () => {
    const { resolver } = makeResolver({
      record: { lexicon: 1, id: NSID, defs: { main: { type: 'record' } } },
    })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/not a permission-set/)
  })

  it('rejects a permission-set with no permissions array', async () => {
    const { resolver } = makeResolver({
      record: { lexicon: 1, id: NSID, defs: { main: { type: 'permission-set' } } },
    })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/no permissions array/)
  })

  it('surfaces a record-fetch failure as PermissionSetResolutionError', async () => {
    const { resolver } = makeResolver({ recordThrows: true })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/could not fetch schema record/)
  })

  it('rejects when the authority DID cannot be resolved', async () => {
    const { resolver } = makeResolver({ pdsThrows: true })
    await expect(resolver.resolve(NSID)).rejects.toThrow(/could not resolve authority DID/)
  })

  it('the default record fetcher calls getRecord with the right collection + rkey', async () => {
    // No `fetchSchemaRecord` override → exercises defaultFetchSchemaRecord (which
    // uses the mocked AtpAgent above).
    mockGetRecord.mockResolvedValueOnce({ data: { value: PERMISSION_SET } })
    const idResolver = {
      did: { resolveAtprotoData: vi.fn(async () => ({ pds: PDS_URL })) },
    } as any
    const resolver = new PermissionSetResolver(idResolver, {
      txtResolver: async () => [[`did=${AUTHORITY_DID}`]],
    })

    const set = await resolver.resolve(NSID)
    expect(set.type).toBe('permission-set')
    expect(mockGetRecord).toHaveBeenCalledWith({
      repo: AUTHORITY_DID,
      collection: 'com.atproto.lexicon.schema',
      rkey: NSID,
    })
  })
})
