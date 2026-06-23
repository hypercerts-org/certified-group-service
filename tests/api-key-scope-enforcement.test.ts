/**
 * Handler-level regression tests for API-key scope enforcement.
 *
 * The gate (assertCanWithAudit) only enforces scopes when the handler passes the
 * caller's credentials. A handler that forgot to pass them would let a key act
 * with its owner's full role — a scope bypass (caught in e2e: audit.query
 * returned 200 for a member.list-only key). These tests exercise the real
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

/** Build an AuthVerifier mock whose xrpcAuth() yields an apiKey principal. */
function apiKeyAuth(scopes: string[]) {
  return {
    verifyServiceAuth: async () => ({ iss: 'did:plc:owner' }),
    resolveRepoToGroup: async () => GROUP,
    xrpcAuth() {
      return async () => ({
        credentials: {
          callerDid: 'did:plc:owner', // key acts as the owner (admin+)
          groupDid: GROUP,
          legacyAud: false,
          authKind: 'apiKey' as const,
          scopes,
          apiKeyRef: 'ref1',
        },
      })
    },
    xrpcServiceAuth() {
      return async () => ({ credentials: { callerDid: 'did:plc:owner' } })
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
    // The issuing owner is an admin+ by role, so any bypass would surface as a
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
})
