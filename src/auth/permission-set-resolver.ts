import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'
import { NSID } from '@atproto/syntax'
import type { LexiconPermissionSet } from '@atproto/oauth-scopes'
import type { Logger } from 'pino'

/**
 * Resolves an AT Protocol **permission set** (a `type: "permission-set"` lexicon)
 * from its NSID, using the standard Lexicon resolution system. CGS needs the set
 * definition to expand an `include:<nsid>` API-key scope into concrete scopes;
 * `@atproto/oauth-scopes` models permission sets but does not fetch them — the
 * caller supplies the `LexiconPermissionSet`.
 *
 * This resolver is **namespace-agnostic**: it resolves any published set via its
 * own namespace authority and has no knowledge of specific namespaces. The chain
 * (see https://atproto.com/specs/lexicon, Resolution):
 *
 *   1. NSID → authority DID, via a DNS `TXT` lookup on `_lexicon.<authority>`
 *      (value `did=<DID>`). `@atproto/identity` does not do this lookup, so it
 *      is implemented here.
 *   2. authority DID → PDS endpoint, via `idResolver`.
 *   3. fetch `com.atproto.repo.getRecord(repo=<DID>,
 *      collection=com.atproto.lexicon.schema, rkey=<full NSID>)`.
 *   4. validate the record's `main` def is `type: "permission-set"`.
 *
 * Results are cached with a TTL (the permission spec recommends a long expiry
 * with a ~24h stale lifetime; the DNS step is deliberately not cached for long,
 * so the whole resolution is cached as one unit with a modest TTL).
 */

/** Thrown when an NSID cannot be resolved to a valid permission set. */
export class PermissionSetResolutionError extends Error {
  constructor(
    public readonly nsid: string,
    public readonly reason: string,
  ) {
    super(`Could not resolve permission set ${nsid}: ${reason}`)
    this.name = 'PermissionSetResolutionError'
  }
}

/** Look up TXT records for a name; injectable so tests need no real DNS. */
export type TxtResolver = (hostname: string) => Promise<string[][]>

/** Fetch a lexicon-schema record from a PDS; injectable for tests. */
export type SchemaRecordFetcher = (
  pdsUrl: string,
  authorityDid: string,
  nsid: string,
) => Promise<unknown>

interface CacheEntry {
  value: LexiconPermissionSet
  expiresAt: number
}

/** Default record fetcher: a plain unauthenticated `getRecord` against the PDS. */
async function defaultFetchSchemaRecord(
  pdsUrl: string,
  authorityDid: string,
  nsid: string,
): Promise<unknown> {
  const agent = new AtpAgent({ service: pdsUrl })
  const res = await agent.com.atproto.repo.getRecord({
    repo: authorityDid,
    collection: 'com.atproto.lexicon.schema',
    rkey: nsid,
  })
  return res.data.value
}

/**
 * Parse the authority DID out of `_lexicon.<authority>` TXT records. The spec
 * format is a single record `did=<DID>`. Multiple `did=` records (an ambiguous
 * authority) are rejected rather than guessed.
 */
function didFromTxtRecords(records: string[][]): string | null {
  // Each record is an array of strings that must be concatenated.
  const dids = records
    .map((chunks) => chunks.join(''))
    .map((s) => s.trim())
    .filter((s) => s.startsWith('did='))
    .map((s) => s.slice('did='.length))
  if (dids.length !== 1) return null
  return dids[0]
}

export class PermissionSetResolver {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly idResolver: IdResolver,
    private readonly opts: {
      /** Cache TTL in ms. */
      ttlMs?: number
      txtResolver?: TxtResolver
      fetchSchemaRecord?: SchemaRecordFetcher
      now?: () => number
      logger?: Logger
    } = {},
  ) {}

  private get ttlMs(): number {
    return this.opts.ttlMs ?? 60 * 60 * 1000 // 1 hour
  }

  private now(): number {
    // `Date.now` is injectable so tests are deterministic.
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /**
   * Resolve a permission set by NSID. Throws `PermissionSetResolutionError` if
   * the NSID is malformed, the authority cannot be found, the record is missing,
   * or it is not a `permission-set`.
   */
  async resolve(nsid: string): Promise<LexiconPermissionSet> {
    const cached = this.cache.get(nsid)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const set = await this.resolveUncached(nsid)
    this.cache.set(nsid, { value: set, expiresAt: this.now() + this.ttlMs })
    return set
  }

  private async resolveUncached(nsid: string): Promise<LexiconPermissionSet> {
    let authority: string
    try {
      authority = NSID.parse(nsid).authority
    } catch {
      throw new PermissionSetResolutionError(nsid, 'not a valid NSID')
    }

    // 1. NSID authority → DID via `_lexicon.<authority>` TXT.
    const txtName = `_lexicon.${authority}`
    let records: string[][]
    try {
      const resolveTxt = this.opts.txtResolver ?? dnsResolveTxt
      records = await resolveTxt(txtName)
    } catch (err) {
      throw new PermissionSetResolutionError(
        nsid,
        `no _lexicon TXT record at ${txtName} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    const authorityDid = didFromTxtRecords(records)
    if (!authorityDid) {
      throw new PermissionSetResolutionError(
        nsid,
        `${txtName} did not yield exactly one did= record`,
      )
    }

    // 2. DID → PDS endpoint.
    let pdsUrl: string | undefined
    try {
      pdsUrl = (await this.idResolver.did.resolveAtprotoData(authorityDid)).pds
    } catch (err) {
      throw new PermissionSetResolutionError(
        nsid,
        `could not resolve authority DID ${authorityDid} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (!pdsUrl || !pdsUrl.startsWith('https://')) {
      throw new PermissionSetResolutionError(
        nsid,
        `authority DID ${authorityDid} has no https PDS endpoint`,
      )
    }

    // 3. Fetch the lexicon-schema record (rkey is the NSID itself).
    const fetchRecord = this.opts.fetchSchemaRecord ?? defaultFetchSchemaRecord
    let value: unknown
    try {
      value = await fetchRecord(pdsUrl, authorityDid, nsid)
    } catch (err) {
      throw new PermissionSetResolutionError(
        nsid,
        `could not fetch schema record (${err instanceof Error ? err.message : String(err)})`,
      )
    }

    // 4. Validate it is a permission-set lexicon and return its main def.
    return assertPermissionSet(nsid, value)
  }
}

/**
 * Validate that a fetched lexicon-schema record's `main` def is a permission set,
 * and narrow it to `LexiconPermissionSet`. The record is the lexicon document, so
 * the permission set is at `defs.main`.
 */
function assertPermissionSet(nsid: string, value: unknown): LexiconPermissionSet {
  const main = (value as { defs?: { main?: unknown } } | null)?.defs?.main as
    | { type?: unknown; permissions?: unknown }
    | undefined
  if (!main || main.type !== 'permission-set') {
    throw new PermissionSetResolutionError(nsid, 'record main def is not a permission-set')
  }
  if (!Array.isArray(main.permissions)) {
    throw new PermissionSetResolutionError(nsid, 'permission-set has no permissions array')
  }
  return main as unknown as LexiconPermissionSet
}
