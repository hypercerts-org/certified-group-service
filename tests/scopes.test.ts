import { describe, it, expect } from 'vitest'
import {
  SERVICE_ID_FRAGMENT,
  serviceScopeAud,
  lxmForOperation,
  scopeNeededFor,
  scopesCoverOperation,
  firstInvalidScope,
  canonicalizeScope,
  canonicalizeScopes,
  expandIncludes,
  repoActionForOperation,
  repoScopesCover,
  blobScopesCover,
} from '../src/auth/scopes.js'
import type { PermissionSetResolver } from '../src/auth/permission-set-resolver.js'

const SERVICE_DID = 'did:web:groups.example.com'

/** A fake resolver: maps NSIDs to permission sets, or throws for unknown ones. */
function fakeResolver(sets: Record<string, unknown>): PermissionSetResolver {
  return {
    resolve: async (nsid: string) => {
      const set = sets[nsid]
      if (!set) throw new Error(`unknown set ${nsid}`)
      return set
    },
  } as unknown as PermissionSetResolver
}

const HYPERCERTS_SET = {
  type: 'permission-set',
  permissions: [
    {
      type: 'permission',
      resource: 'repo',
      collection: ['org.hypercerts.claim.activity', 'org.hypercerts.collection'],
      action: ['create', 'update', 'delete'],
    },
  ],
}
// The package URL-encodes `#` as `%23` in the emitted scope string; use its own
// output as the canonical form rather than hand-writing the encoding.
const MEMBER_LIST_SCOPE = scopeNeededFor('member.list', SERVICE_DID)!

describe('serviceScopeAud', () => {
  it('appends the service-id fragment to the bare DID', () => {
    expect(serviceScopeAud(SERVICE_DID)).toBe(`${SERVICE_DID}#${SERVICE_ID_FRAGMENT}`)
    expect(SERVICE_ID_FRAGMENT).toBe('certified_group_service')
  })
})

describe('lxmForOperation', () => {
  it('maps key-accessible operations to their NSID', () => {
    expect(lxmForOperation('member.list')).toBe('app.certified.group.member.list')
    expect(lxmForOperation('audit.query')).toBe('app.certified.group.audit.query')
  })

  it('returns undefined for operations not reachable by a key', () => {
    expect(lxmForOperation('role.set')).toBeUndefined()
    expect(lxmForOperation('createRecord')).toBeUndefined()
    expect(lxmForOperation('group.destroy')).toBeUndefined()
  })
})

describe('scopeNeededFor', () => {
  it('computes the rpc: scope for a key-accessible op with url-encoded service aud', () => {
    const needed = scopeNeededFor('member.list', SERVICE_DID)
    expect(needed).toBe(
      'rpc:app.certified.group.member.list?aud=did:web:groups.example.com%23certified_group_service',
    )
  })

  it('returns undefined for a non-key-accessible op', () => {
    expect(scopeNeededFor('role.set', SERVICE_DID)).toBeUndefined()
  })
})

describe('scopesCoverOperation', () => {
  it('grants when the exact scope is present', () => {
    expect(scopesCoverOperation([MEMBER_LIST_SCOPE], 'member.list', SERVICE_DID)).toBe(true)
  })

  it('denies when the scope is absent', () => {
    expect(scopesCoverOperation([], 'member.list', SERVICE_DID)).toBe(false)
  })

  it('denies coverage for a different operation', () => {
    expect(scopesCoverOperation([MEMBER_LIST_SCOPE], 'audit.query', SERVICE_DID)).toBe(false)
  })

  it('denies for an op with no lxm mapping even with a wildcard scope', () => {
    const wild = `rpc:*?aud=${serviceScopeAud(SERVICE_DID)}`
    expect(scopesCoverOperation([wild], 'role.set', SERVICE_DID)).toBe(false)
  })

  it('a wildcard rpc scope covers a mapped op', () => {
    const wild = `rpc:*?aud=${serviceScopeAud(SERVICE_DID)}`
    expect(scopesCoverOperation([wild], 'member.list', SERVICE_DID)).toBe(true)
  })

  it('denies when the scope aud is for a different service', () => {
    const otherAud = scopeNeededFor('member.list', 'did:web:evil.example.com')!
    expect(scopesCoverOperation([otherAud], 'member.list', SERVICE_DID)).toBe(false)
  })
})

describe('firstInvalidScope', () => {
  it('returns null when all scopes are valid rpc scopes', () => {
    expect(firstInvalidScope([MEMBER_LIST_SCOPE])).toBeNull()
  })

  it('returns the first invalid scope string', () => {
    expect(firstInvalidScope([MEMBER_LIST_SCOPE, 'not-a-scope'])).toBe('not-a-scope')
  })
})

describe('canonicalizeScope', () => {
  it('expands a friendly rpc:<lxm> to the aud-bound canonical form', () => {
    const r = canonicalizeScope('rpc:app.certified.group.member.list', SERVICE_DID)
    expect(r).toEqual({ ok: true, scope: MEMBER_LIST_SCOPE })
  })

  it('accepts an already-canonical scope whose aud is this service', () => {
    const r = canonicalizeScope(MEMBER_LIST_SCOPE, SERVICE_DID)
    expect(r).toEqual({ ok: true, scope: MEMBER_LIST_SCOPE })
  })

  it('rejects a scope whose aud names a DIFFERENT service DID', () => {
    const foreign = scopeNeededFor('member.list', 'did:web:other.example.com')!
    const r = canonicalizeScope(foreign, SERVICE_DID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/aud must be this service/)
  })

  it('rejects a scope with the right DID but a DIFFERENT service fragment', () => {
    const wrongFragment = `rpc:app.certified.group.member.list?aud=${SERVICE_DID}%23some_other_service`
    const r = canonicalizeScope(wrongFragment, SERVICE_DID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/aud must be this service/)
  })

  it('rejects a malformed / unsupported scope', () => {
    expect(canonicalizeScope('not-a-scope', SERVICE_DID).ok).toBe(false)
    expect(canonicalizeScope('rpc:', SERVICE_DID).ok).toBe(false)
  })
})

describe('canonicalizeScopes', () => {
  it('canonicalizes a whole list', () => {
    const r = canonicalizeScopes(['rpc:app.certified.group.member.list'], SERVICE_DID)
    expect(r).toEqual({ ok: true, scopes: [MEMBER_LIST_SCOPE] })
  })

  it('fails on the first bad scope, naming it', () => {
    const foreign = scopeNeededFor('member.list', 'did:web:other.example.com')!
    const r = canonicalizeScopes(['rpc:app.certified.group.member.list', foreign], SERVICE_DID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.scope).toBe(foreign)
  })
})

const POST = 'app.bsky.feed.post'
const REPO_CREATE = 'repo:app.bsky.feed.post?action=create'

describe('repoActionForOperation', () => {
  it('maps write ops to their repo: action; own/any collapse to the same action', () => {
    expect(repoActionForOperation('createRecord')).toBe('create')
    expect(repoActionForOperation('putOwnRecord')).toBe('update')
    expect(repoActionForOperation('putAnyRecord')).toBe('update')
    expect(repoActionForOperation('putRecord:profile')).toBe('update')
    expect(repoActionForOperation('deleteOwnRecord')).toBe('delete')
    expect(repoActionForOperation('deleteAnyRecord')).toBe('delete')
  })

  it('returns undefined for non-repo-write ops', () => {
    expect(repoActionForOperation('member.list')).toBeUndefined()
    expect(repoActionForOperation('audit.query')).toBeUndefined()
    expect(repoActionForOperation('role.set')).toBeUndefined()
    expect(repoActionForOperation('uploadBlob')).toBeUndefined() // decided in wire-write-handlers
  })
})

describe('repoScopesCover', () => {
  it('grants when a repo: scope covers the collection+action', () => {
    expect(repoScopesCover([REPO_CREATE], 'createRecord', POST)).toBe(true)
  })

  it('denies a different action on the same collection', () => {
    expect(repoScopesCover([REPO_CREATE], 'deleteOwnRecord', POST)).toBe(false)
  })

  it('denies a different collection', () => {
    expect(repoScopesCover([REPO_CREATE], 'createRecord', 'app.bsky.actor.profile')).toBe(false)
  })

  it('a wildcard repo:* scope covers any collection', () => {
    expect(repoScopesCover(['repo:*?action=create'], 'createRecord', POST)).toBe(true)
  })

  it('own and any map to the same delete action (role decides whose records)', () => {
    const del = ['repo:app.bsky.feed.post?action=delete']
    expect(repoScopesCover(del, 'deleteOwnRecord', POST)).toBe(true)
    expect(repoScopesCover(del, 'deleteAnyRecord', POST)).toBe(true)
  })

  it('returns false for a non-repo-write op even with a repo scope', () => {
    expect(repoScopesCover(['repo:*?action=create'], 'member.list', POST)).toBe(false)
  })
})

describe('canonicalizeScope — repo: scopes', () => {
  it('accepts a repo: scope verbatim (normalised, no aud appended)', () => {
    const r = canonicalizeScope(REPO_CREATE, SERVICE_DID)
    expect(r).toEqual({ ok: true, scope: REPO_CREATE })
  })

  it('rejects a malformed repo: scope', () => {
    expect(canonicalizeScope('repo:', SERVICE_DID).ok).toBe(false)
  })

  it('rejects an unsupported scope kind', () => {
    expect(canonicalizeScope('blob:*', SERVICE_DID).ok).toBe(false)
    expect(canonicalizeScope('garbage', SERVICE_DID).ok).toBe(false)
  })

  it('canonicalizes a mixed rpc: + repo: list', () => {
    const r = canonicalizeScopes(['rpc:app.certified.group.member.list', REPO_CREATE], SERVICE_DID)
    expect(r).toEqual({ ok: true, scopes: [MEMBER_LIST_SCOPE, REPO_CREATE] })
  })
})

describe('firstInvalidScope — all kinds', () => {
  it('accepts rpc:, repo: and blob: scopes', () => {
    expect(firstInvalidScope([MEMBER_LIST_SCOPE, REPO_CREATE, 'blob:image/*'])).toBeNull()
  })

  it('rejects an unsupported kind', () => {
    // `account:` is a real atproto scope kind but one CGS does not consume.
    expect(firstInvalidScope([REPO_CREATE, 'account:email?action=read'])).toBe(
      'account:email?action=read',
    )
  })
})

describe('blobScopesCover', () => {
  it('grants when a blob: scope covers the MIME type', () => {
    expect(blobScopesCover(['blob:image/*'], 'image/png')).toBe(true)
    expect(blobScopesCover(['blob:*/*'], 'application/octet-stream')).toBe(true)
  })

  it('denies a MIME type the scope does not cover', () => {
    expect(blobScopesCover(['blob:image/*'], 'video/mp4')).toBe(false)
  })

  it('denies when there is no blob: scope', () => {
    expect(blobScopesCover([REPO_CREATE], 'image/png')).toBe(false)
  })
})

describe('canonicalizeScope — blob: scopes', () => {
  it('accepts a blob: scope verbatim (normalised)', () => {
    expect(canonicalizeScope('blob:image/*', SERVICE_DID)).toEqual({
      ok: true,
      scope: 'blob:image/*',
    })
  })

  it('rejects a malformed blob: scope', () => {
    expect(canonicalizeScope('blob:*', SERVICE_DID).ok).toBe(false)
  })
})

describe('expandIncludes', () => {
  const resolver = fakeResolver({ 'org.hypercerts.authWrite': HYPERCERTS_SET })

  it('expands an include: to one combined repo: scope covering all collections', async () => {
    const res = await expandIncludes(['include:org.hypercerts.authWrite'], SERVICE_DID, resolver)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // IncludeScope.toScopes coalesces the collection array into a single scope.
    expect(res.scopes).toHaveLength(1)
    expect(res.scopes[0]).toContain('collection=org.hypercerts.claim.activity')
    expect(res.scopes[0]).toContain('collection=org.hypercerts.collection')
  })

  it('passes non-include: scopes through untouched', async () => {
    const res = await expandIncludes(
      ['rpc:app.certified.group.member.list', 'blob:image/*'],
      SERVICE_DID,
      resolver,
    )
    expect(res).toEqual({
      ok: true,
      scopes: ['rpc:app.certified.group.member.list', 'blob:image/*'],
    })
  })

  it('mixes an include: with explicit scopes', async () => {
    const res = await expandIncludes(
      ['include:org.hypercerts.authWrite', 'blob:image/*'],
      SERVICE_DID,
      resolver,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.scopes).toContain('blob:image/*')
    expect(res.scopes.some((s) => s.includes('collection=org.hypercerts.'))).toBe(true)
  })

  it('returns ok:false naming the include: when the set cannot be resolved', async () => {
    const res = await expandIncludes(['include:org.unknown.authWrite'], SERVICE_DID, resolver)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.scope).toBe('include:org.unknown.authWrite')
    expect(res.reason).toMatch(/unknown set/)
  })

  it('the expanded scopes pass canonicalizeScopes', async () => {
    const res = await expandIncludes(['include:org.hypercerts.authWrite'], SERVICE_DID, resolver)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const canon = canonicalizeScopes(res.scopes, SERVICE_DID)
    expect(canon.ok).toBe(true)
  })
})
