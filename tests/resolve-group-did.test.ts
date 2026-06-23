/**
 * resolveGroupDid: how the target group is chosen per auth mode. The API-key
 * path is stricter than JWT — the key is authenticated against the querystring
 * `repo` (already resolved into credentials.groupDid), so a body `repo` cannot
 * redirect the action to a different group (confused-deputy guard).
 */
import { describe, it, expect } from 'vitest'
import { resolveGroupDid } from '../src/api/util.js'
import type { AppContext } from '../src/context.js'

const GROUP_A = 'did:plc:groupA'
const GROUP_B = 'did:plc:groupB'

// Minimal ctx: resolveGroupDid only ever calls authVerifier.resolveRepoToGroup.
// Resolve a handle/DID to a group by a tiny fixed map; unknown -> throw.
function makeCtx(): AppContext {
  return {
    authVerifier: {
      resolveRepoToGroup: async (repo: string) => {
        if (repo === GROUP_A || repo === 'a.example.com') return GROUP_A
        if (repo === GROUP_B || repo === 'b.example.com') return GROUP_B
        throw new Error('Unknown group')
      },
    },
  } as unknown as AppContext
}

describe('resolveGroupDid — JWT/legacy callers', () => {
  it('body repo wins when present', async () => {
    const ctx = makeCtx()
    const did = await resolveGroupDid(ctx, { authKind: 'jwt', groupDid: GROUP_A }, GROUP_B)
    expect(did).toBe(GROUP_B)
  })

  it("falls back to the credential's groupDid when no body repo", async () => {
    const ctx = makeCtx()
    const did = await resolveGroupDid(ctx, { authKind: 'jwt', groupDid: GROUP_A }, undefined)
    expect(did).toBe(GROUP_A)
  })

  it('throws when neither body repo nor credential groupDid is present', async () => {
    const ctx = makeCtx()
    await expect(resolveGroupDid(ctx, { authKind: 'jwt' }, undefined)).rejects.toThrow(
      /Missing repo/,
    )
  })
})

describe('resolveGroupDid — API-key callers (stricter)', () => {
  it("uses the credential's groupDid (querystring) and ignores a matching body repo", async () => {
    const ctx = makeCtx()
    // Body repo names the SAME group (as a handle) — allowed.
    const did = await resolveGroupDid(
      ctx,
      { authKind: 'apiKey', groupDid: GROUP_A },
      'a.example.com',
    )
    expect(did).toBe(GROUP_A)
  })

  it('uses the credential groupDid when there is no body repo', async () => {
    const ctx = makeCtx()
    const did = await resolveGroupDid(ctx, { authKind: 'apiKey', groupDid: GROUP_A }, undefined)
    expect(did).toBe(GROUP_A)
  })

  it('REJECTS a body repo that resolves to a different group (confused deputy)', async () => {
    const ctx = makeCtx()
    await expect(
      resolveGroupDid(ctx, { authKind: 'apiKey', groupDid: GROUP_A }, GROUP_B),
    ).rejects.toThrow(/must match the querystring `repo`/)
  })

  it('throws Missing repo if an apiKey credential somehow lacks a group', async () => {
    const ctx = makeCtx()
    await expect(resolveGroupDid(ctx, { authKind: 'apiKey' }, undefined)).rejects.toThrow(
      /Missing repo/,
    )
  })
})
