import { describe, it, expect, beforeEach } from 'vitest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import type { AppContext } from '../src/context.js'
import { createTestContext, seedMember } from './helpers/mock-server.js'
import { assertCanWithAudit, type GatePrincipal } from '../src/api/util.js'
import { scopeNeededFor } from '../src/auth/scopes.js'

const SERVICE_DID = 'did:web:test.example.com'
const MEMBER_LIST_SCOPE = scopeNeededFor('member.list', SERVICE_DID)!

async function lastAudit(groupDb: Kysely<GroupDatabase>) {
  return groupDb.selectFrom('group_audit_log').selectAll().orderBy('id', 'desc').executeTakeFirst()
}

describe('assertCanWithAudit — API-key scope gate', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    // The key acts as its issuing member; seed that issuer as a member.
    await seedMember(groupDb, 'did:plc:owner', 'owner')
  })

  const apiKeyPrincipal = (scopes: string[], apiKeyRef = 'ref123'): GatePrincipal => ({
    authKind: 'apiKey',
    scopes,
    apiKeyRef,
  })

  it('permits when the key scope covers the operation AND the role allows it', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'member.list',
        undefined,
        apiKeyPrincipal([MEMBER_LIST_SCOPE]),
      ),
    ).resolves.toBe('owner')
  })

  it('denies (and audits) when the key lacks the required scope', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'member.list',
        undefined,
        apiKeyPrincipal([]),
      ),
    ).rejects.toThrow(/scopes do not permit/)

    const audit = await lastAudit(groupDb)
    expect(audit?.result).toBe('denied')
    expect(audit?.action).toBe('member.list')
    const detail = JSON.parse(audit!.detail!)
    expect(detail.apiKeyRef).toBe('ref123')
    expect(detail.reason).toMatch(/scopes do not permit/)
  })

  it('denies for an operation that is not key-accessible even with a wildcard scope', async () => {
    const wild = `rpc:*?aud=${SERVICE_DID}%23certified_group_service`
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'role.set',
        undefined,
        apiKeyPrincipal([wild]),
      ),
    ).rejects.toThrow(/scopes do not permit/)
  })

  it('denies (and audits) when the scope passes but the issuer role is insufficient', async () => {
    // A member-role issuer holds the member.list scope but member.add needs admin.
    // member.add is not key-accessible (no lxm), so scope check fails first —
    // assert the role path instead with an op the key *can* reach but the role
    // cannot. Demote: seed a non-owner issuer with only member.list scope.
    await seedMember(groupDb, 'did:plc:member', 'member')
    // audit.query is key-accessible (has an lxm) but needs admin role.
    const auditScope = scopeNeededFor('audit.query', SERVICE_DID)!
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:member',
        'audit.query',
        undefined,
        apiKeyPrincipal([auditScope]),
      ),
    ).rejects.toThrow(/cannot perform/)

    const audit = await lastAudit(groupDb)
    expect(audit?.result).toBe('denied')
    const detail = JSON.parse(audit!.detail!)
    expect(detail.apiKeyRef).toBe('ref123')
  })

  it('attaches apiKeyRef to the audit detail on a denial', async () => {
    await assertCanWithAudit(
      ctx,
      groupDb,
      'did:plc:owner',
      'member.list',
      undefined,
      apiKeyPrincipal([], 'specific-ref'),
    ).catch(() => {})
    const audit = await lastAudit(groupDb)
    expect(JSON.parse(audit!.detail!).apiKeyRef).toBe('specific-ref')
  })

  it('JWT principals skip the scope check (role-only)', async () => {
    // No scopes at all, but a JWT principal is scope-unlimited.
    await expect(
      assertCanWithAudit(ctx, groupDb, 'did:plc:owner', 'member.list', undefined, {
        authKind: 'jwt',
      }),
    ).resolves.toBe('owner')
  })

  it('omitting the principal behaves like a JWT caller (back-compat)', async () => {
    await expect(assertCanWithAudit(ctx, groupDb, 'did:plc:owner', 'member.list')).resolves.toBe(
      'owner',
    )
  })

  // --- PDS-repo write ops gated by repo: scopes (collection+action) ---

  const POST = 'app.bsky.feed.post'
  const detailFor = (collection: string) => ({ collection })

  it('permits createRecord when a repo: scope covers the collection+action', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'createRecord',
        detailFor(POST),
        apiKeyPrincipal([`repo:${POST}?action=create`]),
      ),
    ).resolves.toBe('owner')
  })

  it('denies createRecord on a collection the repo: scope does not cover', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'createRecord',
        detailFor('app.bsky.actor.profile'),
        apiKeyPrincipal([`repo:${POST}?action=create`]),
      ),
    ).rejects.toThrow(/scopes do not permit/)
  })

  it('denies createRecord when the repo: scope grants a different action', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'createRecord',
        detailFor(POST),
        apiKeyPrincipal([`repo:${POST}?action=delete`]),
      ),
    ).rejects.toThrow(/scopes do not permit/)
  })

  it('denies a write when the key only holds an rpc: (read) scope', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'createRecord',
        detailFor(POST),
        apiKeyPrincipal([MEMBER_LIST_SCOPE]),
      ),
    ).rejects.toThrow(/scopes do not permit/)
  })

  it('denies a write when the collection is missing from the request detail', async () => {
    await expect(
      assertCanWithAudit(
        ctx,
        groupDb,
        'did:plc:owner',
        'createRecord',
        undefined, // no collection
        apiKeyPrincipal([`repo:${POST}?action=create`]),
      ),
    ).rejects.toThrow(/scopes do not permit/)
  })

  it('deleteOwnRecord and deleteAnyRecord are both covered by an action=delete scope', async () => {
    const del = apiKeyPrincipal([`repo:${POST}?action=delete`])
    await expect(
      assertCanWithAudit(ctx, groupDb, 'did:plc:owner', 'deleteOwnRecord', detailFor(POST), del),
    ).resolves.toBe('owner')
    await expect(
      assertCanWithAudit(ctx, groupDb, 'did:plc:owner', 'deleteAnyRecord', detailFor(POST), del),
    ).resolves.toBe('owner')
  })
})
