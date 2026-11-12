/**
 * Handler-level regression tests for API-key scope enforcement.
 *
 * The gate (assertCanWithAudit) only enforces scopes when the handler passes the
 * caller's credentials. A handler that forgot to pass them would let a key act
 * with its issuing member's full role — a scope bypass (caught in e2e:
 * audit.query returned 200 for a member.list-only key). These tests exercise the real
 * handlers with an apiKey principal to prove every key-reachable handler routes
 * the principal into the gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { createTestContext, seedMember, createTestApp, mockAuth } from './helpers/mock-server.js'
import memberListHandler from '../src/api/member/list.js'
import auditQueryHandler from '../src/api/audit/query.js'
import memberAddHandler from '../src/api/member/add.js'
import memberRemoveHandler from '../src/api/member/remove.js'
import roleSetHandler from '../src/api/role/set.js'
import { scopeNeededFor } from '../src/auth/scopes.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const SERVICE_DID = 'did:web:test.example.com'
const GROUP = 'did:plc:testgroup'
const MEMBER_LIST_SCOPE = scopeNeededFor('member.list', SERVICE_DID)!
const AUDIT_QUERY_SCOPE = scopeNeededFor('audit.query', SERVICE_DID)!

/** Build an AuthVerifier mock whose xrpcAuth() yields an apiKey principal. */
function apiKeyAuth(scopes: string[], callerDid = 'did:plc:owner') {
  return {
    verifyServiceAuth: async () => ({ iss: callerDid }),
    resolveRepoToGroup: async () => GROUP,
    xrpcAuth() {
      return async () => ({
        credentials: {
          callerDid,
          groupDid: GROUP,
          legacyAud: false,
          authKind: 'apiKey' as const,
          scopes,
          apiKeyRef: 'ref1',
        },
      })
    },
    xrpcServiceAuth() {
      return async () => ({ credentials: { callerDid } })
    },
  } as unknown as AppContext['authVerifier']
}

describe('API-key scope enforcement at the handler layer', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    // The issuing member is an admin+ by role, so any bypass would surface as a
    // role-permitted 200 rather than a scope-denied 403.
    await seedMember(groupDb, 'did:plc:owner', 'owner')
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  function app(handler: (s: Parameters<typeof memberListHandler>[0], c: AppContext) => void) {
    return createTestApp(ctx, (server, appCtx) => handler(server, appCtx))
  }

  it('member.list: a key scoped to member.list is allowed (200)', async () => {
    ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
    const res = await request(app(memberListHandler)).get(
      `/xrpc/app.certified.group.member.list?repo=${GROUP}`,
    )
    expect(res.status).toBe(200)
  })

  it('audit.query: a key scoped only to member.list is DENIED (403) — the e2e regression', async () => {
    ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
    const res = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    // Before the fix this returned 200: the handler did not pass the principal,
    // so the gate skipped the scope check and the owner-role caller passed.
    expect(res.status).toBe(403)
  })

  it('member.list: a key with NO scopes is denied (403)', async () => {
    ctx.authVerifier = apiKeyAuth([])
    const res = await request(app(memberListHandler)).get(
      `/xrpc/app.certified.group.member.list?repo=${GROUP}`,
    )
    expect(res.status).toBe(403)
  })

  it('audit.query: an admin-issued key with audit.query scope is allowed (200)', async () => {
    await seedMember(groupDb, 'did:plc:admin', 'admin')
    ctx.authVerifier = apiKeyAuth([AUDIT_QUERY_SCOPE], 'did:plc:admin')
    const res = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    expect(res.status).toBe(200)
  })

  it('audit.query: a member-issued key is capped by member role even with audit.query scope', async () => {
    await seedMember(groupDb, 'did:plc:member', 'member')
    ctx.authVerifier = apiKeyAuth([AUDIT_QUERY_SCOPE], 'did:plc:member')
    const res = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    expect(res.status).toBe(403)
  })

  // A wildcard key is allowed at creation for any role (it names no operation),
  // so the role cap has to hold at request time — otherwise a member could mint
  // `rpc:*` and reach admin-only operations.
  it('wildcard: a member-issued rpc:* key reaches member.list (200) but not audit.query (403)', async () => {
    await seedMember(groupDb, 'did:plc:member', 'member')
    const wild = `rpc:*?aud=${SERVICE_DID}%23certified_group_service`

    ctx.authVerifier = apiKeyAuth([wild], 'did:plc:member')
    const allowed = await request(app(memberListHandler)).get(
      `/xrpc/app.certified.group.member.list?repo=${GROUP}`,
    )
    expect(allowed.status).toBe(200)

    ctx.authVerifier = apiKeyAuth([wild], 'did:plc:member')
    const denied = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    expect(denied.status).toBe(403)
  })

  // The member case above pins the floor (denied above role). These pin the
  // ceiling: a higher role's wildcard must actually reach the operation, or the
  // wildcard could silently match nothing and still look correct.
  it('wildcard: an admin-issued rpc:* key reaches the admin-level audit.query (200)', async () => {
    await seedMember(groupDb, 'did:plc:admin', 'admin')
    const wild = `rpc:*?aud=${SERVICE_DID}%23certified_group_service`

    ctx.authVerifier = apiKeyAuth([wild], 'did:plc:admin')
    const res = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    expect(res.status).toBe(200)
  })

  it('wildcard: an owner-issued rpc:* key reaches audit.query and member.list (200)', async () => {
    const wild = `rpc:*?aud=${SERVICE_DID}%23certified_group_service`

    ctx.authVerifier = apiKeyAuth([wild], 'did:plc:owner')
    const audit = await request(app(auditQueryHandler)).get(
      `/xrpc/app.certified.group.audit.query?repo=${GROUP}`,
    )
    expect(audit.status).toBe(200)

    ctx.authVerifier = apiKeyAuth([wild], 'did:plc:owner')
    const members = await request(app(memberListHandler)).get(
      `/xrpc/app.certified.group.member.list?repo=${GROUP}`,
    )
    expect(members.status).toBe(200)
  })

  it('member.list: a removed issuer is denied even when the key scope covers the operation', async () => {
    ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE], 'did:plc:removed')
    const res = await request(app(memberListHandler)).get(
      `/xrpc/app.certified.group.member.list?repo=${GROUP}`,
    )
    expect(res.status).toBe(403)
  })

  // member.add, member.remove and role.set are key-accessible: a key needs the
  // matching rpc: scope, and is then capped by its issuer's role.
  describe('membership mutations through API keys', () => {
    const WILDCARD = `rpc:*?aud=${SERVICE_DID}%23certified_group_service`
    const ADD_SCOPE = scopeNeededFor('member.add', SERVICE_DID)!
    const REMOVE_SCOPE = scopeNeededFor('member.remove', SERVICE_DID)!
    const ROLE_SCOPE = scopeNeededFor('role.set', SERVICE_DID)!

    async function memberRole(did: string) {
      const row = await groupDb
        .selectFrom('group_members')
        .select('role')
        .where('member_did', '=', did)
        .executeTakeFirst()
      return row?.role
    }

    async function auditRows(action: string) {
      return groupDb
        .selectFrom('group_audit_log')
        .selectAll()
        .where('action', '=', action)
        .orderBy('id', 'asc')
        .execute()
    }

    async function expectLatestAudit(action: string, result: string, apiKeyRef?: string) {
      const rows = await auditRows(action)
      const last = rows[rows.length - 1]
      expect(last?.result).toBe(result)
      const detail = JSON.parse(last.detail!)
      if (apiKeyRef === undefined) expect(detail).not.toHaveProperty('apiKeyRef')
      else expect(detail.apiKeyRef).toBe(apiKeyRef)
    }

    async function expectExactlyOneDenied(action: string) {
      const rows = await auditRows(action)
      expect(rows).toHaveLength(1)
      expect(rows[0].result).toBe('denied')
      expect(JSON.parse(rows[0].detail!).apiKeyRef).toBe('ref1')
    }

    // A role denial must be told apart from a scope denial: the RBAC layer
    // writes `Role '<role>' cannot perform '<op>'`, the scope gate writes
    // `API key scopes do not permit '<op>'`.
    async function expectLatestRoleDenial(action: string, role: string) {
      const rows = await auditRows(action)
      const last = rows[rows.length - 1]
      expect(last?.result).toBe('denied')
      const reason = JSON.parse(last.detail!).reason as string
      expect(reason).toBe(`Role '${role}' cannot perform '${action}'`)
      expect(reason).not.toContain('API key scopes do not permit')
    }

    const add = (body: object) =>
      request(app(memberAddHandler)).post('/xrpc/app.certified.group.member.add').send(body)
    const remove = (body: object) =>
      request(app(memberRemoveHandler)).post('/xrpc/app.certified.group.member.remove').send(body)
    const setRole = (body: object) =>
      request(app(roleSetHandler)).post('/xrpc/app.certified.group.role.set').send(body)

    beforeEach(async () => {
      await seedMember(groupDb, 'did:plc:member', 'member')
      await seedMember(groupDb, 'did:plc:admin', 'admin')
    })

    describe('a key with the matching scope', () => {
      it('member.add: succeeds, adds the member, audits permitted with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([ADD_SCOPE])
        const res = await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })
        expect(res.status).toBe(200)
        expect(await memberRole('did:plc:newcomer')).toBe('member')
        await expectLatestAudit('member.add', 'permitted', 'ref1')
      })

      it('role.set: succeeds, changes the role, audits permitted with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([ROLE_SCOPE])
        const res = await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'admin' })
        expect(res.status).toBe(200)
        expect(await memberRole('did:plc:member')).toBe('admin')
        await expectLatestAudit('role.set', 'permitted', 'ref1')
      })

      it('member.remove: succeeds, removes the member, audits permitted with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([REMOVE_SCOPE])
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:member' })
        expect(res.status).toBe(200)
        expect(await memberRole('did:plc:member')).toBeUndefined()
        await expectLatestAudit('member.remove', 'permitted', 'ref1')
      })
    })

    describe('a key without the matching scope', () => {
      it('member.add: 403, member not added, one denied audit with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
        const res = await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })
        expect(res.status).toBe(403)
        expect(res.body.error).toBe('Forbidden')
        expect(await memberRole('did:plc:newcomer')).toBeUndefined()
        await expectExactlyOneDenied('member.add')
      })

      it('role.set: 403, role unchanged, one denied audit with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([`repo:app.certified.group.test?action=create`])
        const res = await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'admin' })
        expect(res.status).toBe(403)
        expect(await memberRole('did:plc:member')).toBe('member')
        await expectExactlyOneDenied('role.set')
      })

      it('member.remove: 403, member stays, one denied audit with apiKeyRef', async () => {
        ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:member' })
        expect(res.status).toBe(403)
        expect(await memberRole('did:plc:member')).toBe('member')
        await expectExactlyOneDenied('member.remove')
      })

      it('member.remove: a non-member target gets 403, not 404', async () => {
        ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:nobody' })
        expect(res.status).toBe(403)
        await expectExactlyOneDenied('member.remove')
      })

      it('role.set: a non-member target gets 403, not 404', async () => {
        ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE])
        const res = await setRole({ repo: GROUP, memberDid: 'did:plc:nobody', role: 'admin' })
        expect(res.status).toBe(403)
        await expectExactlyOneDenied('role.set')
      })
    })

    describe('role caps with rpc:* keys', () => {
      it('member-issued: refused member.add, member.remove of others and role.set', async () => {
        await seedMember(groupDb, 'did:plc:other', 'member')
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:member')
        expect(
          (await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })).status,
        ).toBe(403)
        expect((await remove({ repo: GROUP, memberDid: 'did:plc:other' })).status).toBe(403)
        expect(
          (await setRole({ repo: GROUP, memberDid: 'did:plc:other', role: 'admin' })).status,
        ).toBe(403)
        expect(await memberRole('did:plc:newcomer')).toBeUndefined()
        expect(await memberRole('did:plc:other')).toBe('member')
        await expectLatestRoleDenial('member.add', 'member')
        await expectLatestRoleDenial('member.remove', 'member')
        await expectLatestRoleDenial('role.set', 'member')
      })

      it('admin-issued: member.add works, role.set refused, adding an admin refused', async () => {
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:admin')
        expect(
          (await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })).status,
        ).toBe(200)
        expect(
          (await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'admin' })).status,
        ).toBe(403)
        expect(await memberRole('did:plc:member')).toBe('member')
        const adminAdd = await add({ repo: GROUP, memberDid: 'did:plc:newadmin', role: 'admin' })
        expect(adminAdd.status).toBe(403)
        expect(await memberRole('did:plc:newadmin')).toBeUndefined()
        // role.set is the role-denied call (admin cannot perform it); the denied
        // admin add is refused by the equal-or-higher rule, not the scope gate.
        await expectLatestRoleDenial('role.set', 'admin')
      })

      it('owner-issued: reaches member.add, role.set and member.remove', async () => {
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:owner')
        expect(
          (await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })).status,
        ).toBe(200)
        expect(
          (await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'admin' })).status,
        ).toBe(200)
        expect((await remove({ repo: GROUP, memberDid: 'did:plc:newcomer' })).status).toBe(200)
        expect(await memberRole('did:plc:member')).toBe('admin')
        expect(await memberRole('did:plc:newcomer')).toBeUndefined()
      })
    })

    describe('existing rules still apply to key callers', () => {
      beforeEach(() => {
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:owner')
      })

      it('member.remove: CannotRemoveOwner', async () => {
        ctx.authVerifier = apiKeyAuth([REMOVE_SCOPE], 'did:plc:admin')
        // An admin key hits the equal-or-higher check only after the owner check.
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:owner' })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('CannotRemoveOwner')
        expect(await memberRole('did:plc:owner')).toBe('owner')
      })

      it('role.set: CannotModifyOwner', async () => {
        const res = await setRole({ repo: GROUP, memberDid: 'did:plc:owner', role: 'admin' })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('CannotModifyOwner')
        expect(await memberRole('did:plc:owner')).toBe('owner')
      })

      it('role.set: CannotPromoteToOwner', async () => {
        const res = await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'owner' })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('CannotPromoteToOwner')
        expect(await memberRole('did:plc:member')).toBe('member')
      })

      it('member.remove: refuses to remove an equal-or-higher role', async () => {
        await seedMember(groupDb, 'did:plc:admin2', 'admin')
        ctx.authVerifier = apiKeyAuth([REMOVE_SCOPE], 'did:plc:admin')
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:admin2' })
        expect(res.status).toBe(403)
        expect(await memberRole('did:plc:admin2')).toBe('admin')
      })
    })

    describe('self-removal', () => {
      // Self-removal skips the role check, so the issuer's role is irrelevant.
      // The owner row is the one case where the owner-immutability rule must
      // still win, so it is pinned separately from the member case below.
      it('an owner-issued rpc:* key cannot remove its own issuer (CannotRemoveOwner)', async () => {
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:owner')
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:owner' })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('CannotRemoveOwner')
        expect(await memberRole('did:plc:owner')).toBe('owner')
      })

      it('a member-issued rpc:* key can remove its own issuer (role check skipped)', async () => {
        ctx.authVerifier = apiKeyAuth([WILDCARD], 'did:plc:member')
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:member' })
        expect(res.status).toBe(200)
        expect(await memberRole('did:plc:member')).toBeUndefined()
        await expectLatestAudit('member.remove', 'permitted', 'ref1')
      })

      it('a member-issued key without the scope gets 403 and the member stays', async () => {
        ctx.authVerifier = apiKeyAuth([MEMBER_LIST_SCOPE], 'did:plc:member')
        const res = await remove({ repo: GROUP, memberDid: 'did:plc:member' })
        expect(res.status).toBe(403)
        expect(await memberRole('did:plc:member')).toBe('member')
        await expectExactlyOneDenied('member.remove')
      })
    })

    it('a JWT caller permitted audit carries no apiKeyRef', async () => {
      ctx.authVerifier = mockAuth('did:plc:owner')
      const res = await add({ repo: GROUP, memberDid: 'did:plc:newcomer', role: 'member' })
      expect(res.status).toBe(200)
      await expectLatestAudit('member.add', 'permitted')
    })

    it('a JWT caller permitted member.remove audit carries no apiKeyRef', async () => {
      ctx.authVerifier = mockAuth('did:plc:owner')
      const res = await remove({ repo: GROUP, memberDid: 'did:plc:member' })
      expect(res.status).toBe(200)
      await expectLatestAudit('member.remove', 'permitted')
    })

    it('a JWT caller permitted role.set audit carries no apiKeyRef', async () => {
      ctx.authVerifier = mockAuth('did:plc:owner')
      const res = await setRole({ repo: GROUP, memberDid: 'did:plc:member', role: 'admin' })
      expect(res.status).toBe(200)
      await expectLatestAudit('role.set', 'permitted')
    })
  })
})
