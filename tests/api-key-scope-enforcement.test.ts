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
import { createTestContext, seedMember, createTestApp } from './helpers/mock-server.js'
import memberListHandler from '../src/api/member/list.js'
import auditQueryHandler from '../src/api/audit/query.js'
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
})
