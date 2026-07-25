import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'
import {
  createTestContext,
  createTestApp,
  seedMemberWithIndex,
  mockAdminVerifier,
  TEST_ADMIN_PASSWORD,
} from './helpers/mock-server.js'
import adminSetOwnerHandler from '../src/api/admin/setOwner.js'
import proposeHandler from '../src/api/ownershipTransfer/propose.js'
import acceptHandler from '../src/api/ownershipTransfer/accept.js'
import cancelHandler from '../src/api/ownershipTransfer/cancel.js'
import statusHandler from '../src/api/ownershipTransfer/status.js'
import memberRemoveHandler from '../src/api/member/remove.js'
import roleSetHandler from '../src/api/role/set.js'
import { scopeNeededFor } from '../src/auth/scopes.js'
import type { AppContext } from '../src/context.js'

const PROPOSE = 'app.certified.group.ownershipTransfer.propose'
const ACCEPT = 'app.certified.group.ownershipTransfer.accept'
const CANCEL = 'app.certified.group.ownershipTransfer.cancel'
const STATUS = 'app.certified.group.ownershipTransfer.status'

const GROUP = 'did:plc:testgroup'
const OWNER = 'did:plc:owner1'
const ADMIN = 'did:plc:admin1'
const MEMBER = 'did:plc:member1'
const OUTSIDER = 'did:plc:outsider1'

const MEMBER_REMOVE = 'app.certified.group.member.remove'
const ROLE_SET = 'app.certified.group.role.set'

const registerAll = (server: any, appCtx: AppContext) => {
  proposeHandler(server, appCtx)
  acceptHandler(server, appCtx)
  cancelHandler(server, appCtx)
  statusHandler(server, appCtx)
  // Registered so the stale-row invalidation tests can drive membership changes
  // through the real handlers on the same app.
  memberRemoveHandler(server, appCtx)
  roleSetHandler(server, appCtx)
}

describe('ownershipTransfer', () => {
  let groupDb: Kysely<GroupDatabase>
  let globalDb: Kysely<GroupDatabase & GlobalDatabase>
  let ctx: AppContext
  let app: express.Express
  // Mutable authenticated caller, flipped per request via `as()`.
  let caller: string

  /** Set the authenticated caller for the next request, returning a supertest agent. */
  const as = (did: string): ReturnType<typeof request> => {
    caller = did
    return request(app)
  }

  beforeEach(async () => {
    const tc = await createTestContext()
    groupDb = tc.groupDb
    globalDb = tc.globalDb as any
    ctx = tc.ctx
    caller = OWNER

    // A verifier that reports whichever caller `as()` last selected, on the new
    // (#27) path: group comes from the querystring/body `repo`, not the aud.
    const resolveRepoToGroup = async (repo: string) => {
      if (repo === GROUP || repo === 'group.example.com') return GROUP
      const { AuthRequiredError } = await import('@atproto/xrpc-server')
      throw new AuthRequiredError('Unknown group')
    }
    ctx.authVerifier = {
      verify: async (req: any) => {
        const repo = typeof req?.query?.repo === 'string' ? req.query.repo : undefined
        const groupDid = repo !== undefined ? await resolveRepoToGroup(repo) : undefined
        return { iss: caller, groupDid, legacyAud: false }
      },
      resolveRepoToGroup,
      xrpcAuth() {
        return async ({ req }: { req: any }) => {
          const { iss, groupDid, legacyAud } = await this.verify(req)
          return { credentials: { callerDid: iss, groupDid, legacyAud, authKind: 'jwt' } }
        }
      },
    } as any

    app = createTestApp(ctx, registerAll)

    await seedMemberWithIndex(groupDb, globalDb as any, OWNER, GROUP, 'owner')
    await seedMemberWithIndex(groupDb, globalDb as any, ADMIN, GROUP, 'admin')
    await seedMemberWithIndex(groupDb, globalDb as any, MEMBER, GROUP, 'member')
  })

  afterEach(async () => {
    await groupDb.destroy()
    await (globalDb as any).destroy()
  })

  const roleOf = async (did: string) =>
    (
      await groupDb
        .selectFrom('group_members')
        .select('role')
        .where('member_did', '=', did)
        .executeTakeFirst()
    )?.role

  const indexRoleOf = async (did: string) =>
    (
      await (globalDb as any)
        .selectFrom('member_index')
        .select('role')
        .where('member_did', '=', did)
        .where('group_did', '=', GROUP)
        .executeTakeFirst()
    )?.role

  const pendingRow = async () =>
    groupDb.selectFrom('pending_ownership_transfer').selectAll().executeTakeFirst()

  /** Force the pending row's expiry into the past to exercise lazy expiry. */
  const expirePending = async () => {
    await groupDb
      .updateTable('pending_ownership_transfer')
      .set({ expires_at: sql`datetime('now', '-1 seconds')` })
      .execute()
  }

  // --- propose -------------------------------------------------------------

  describe('propose', () => {
    it('owner proposes an existing member; ownership does not move yet', async () => {
      const res = await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        groupDid: GROUP,
        proposedOwner: ADMIN,
        proposedBy: OWNER,
      })
      expect(res.body.expiresAt).toBeDefined()
      // Roles unchanged — the handshake is not complete.
      expect(await roleOf(OWNER)).toBe('owner')
      expect(await roleOf(ADMIN)).toBe('admin')
      // Pending row recorded.
      const row = await pendingRow()
      expect(row).toMatchObject({ proposer_did: OWNER, recipient_did: ADMIN, id: 1 })
    })

    it('a second propose replaces the first (single pending row)', async () => {
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })
      const res = await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: MEMBER })

      expect(res.status).toBe(200)
      expect(res.body.proposedOwner).toBe(MEMBER)
      const rows = await groupDb.selectFrom('pending_ownership_transfer').selectAll().execute()
      expect(rows).toHaveLength(1)
      expect(rows[0].recipient_did).toBe(MEMBER)
    })

    it('rejects a non-owner proposer (admin) with Forbidden', async () => {
      const res = await as(ADMIN).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: MEMBER })

      expect(res.status).toBe(403)
      expect(await pendingRow()).toBeUndefined()
    })

    it('rejects proposing a non-member', async () => {
      const res = await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: OUTSIDER })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('NotAMember')
    })

    it('rejects proposing the current owner', async () => {
      const res = await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: OWNER })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('AlreadyOwner')
    })

    it('rejects an invalid newOwner DID', async () => {
      const res = await as(OWNER)
        .post(`/xrpc/${PROPOSE}`)
        .send({ repo: GROUP, newOwner: 'did:bad' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('InvalidRequest')
    })

    it('resolves a newOwner handle to a DID', async () => {
      ctx.idResolver = { handle: { resolve: async () => ADMIN } } as any
      const res = await as(OWNER)
        .post(`/xrpc/${PROPOSE}`)
        .send({ repo: GROUP, newOwner: 'admin.example.com' })

      expect(res.status).toBe(200)
      expect(res.body.proposedOwner).toBe(ADMIN)
    })

    it('rejects an unresolvable newOwner handle', async () => {
      ctx.idResolver = { handle: { resolve: async () => undefined } } as any
      const res = await as(OWNER)
        .post(`/xrpc/${PROPOSE}`)
        .send({ repo: GROUP, newOwner: 'ghost.example.com' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('InvalidRequest')
    })
  })

  // --- accept --------------------------------------------------------------

  describe('accept', () => {
    beforeEach(async () => {
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })
    })

    it('the proposed owner accepts: ownership moves atomically in both DBs', async () => {
      const res = await as(ADMIN).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ groupDid: GROUP, owner: ADMIN, previousOwner: OWNER })
      expect(await roleOf(ADMIN)).toBe('owner')
      expect(await roleOf(OWNER)).toBe('admin')
      expect(await indexRoleOf(ADMIN)).toBe('owner')
      expect(await indexRoleOf(OWNER)).toBe('admin')
      // Pending row cleared.
      expect(await pendingRow()).toBeUndefined()
    })

    it('rejects acceptance by anyone other than the proposed owner', async () => {
      const res = await as(MEMBER).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('NotProposedOwner')
      // Nothing moved.
      expect(await roleOf(OWNER)).toBe('owner')
      expect(await roleOf(ADMIN)).toBe('admin')
      expect(await pendingRow()).toBeDefined()
    })

    it('rejects acceptance when there is no pending transfer', async () => {
      await groupDb.deleteFrom('pending_ownership_transfer').execute()
      const res = await as(ADMIN).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('NoPendingTransfer')
    })

    it('still succeeds (and warns) if the proposal was replaced before the post-accept clear', async () => {
      // Simulate a concurrent propose swapping the pinned row in the window
      // between accept reading it and clearing it: clearIfMatches finds no row
      // for the original pair and returns false. The transfer must still succeed;
      // the handler logs a warning rather than failing.
      const warnings: unknown[] = []
      ctx.logger.warn = ((obj: unknown) => {
        warnings.push(obj)
      }) as typeof ctx.logger.warn
      ctx.pendingTransfers.clearIfMatches = async () => false

      const res = await as(ADMIN).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })

      expect(res.status).toBe(200)
      expect(res.body.owner).toBe(ADMIN)
      expect(await roleOf(ADMIN)).toBe('owner')
      expect(warnings).toHaveLength(1)
    })

    it('treats an expired proposal as no pending transfer (lazy expiry)', async () => {
      await expirePending()
      const res = await as(ADMIN).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('NoPendingTransfer')
      expect(await roleOf(ADMIN)).toBe('admin')
    })

    it('defensively rejects (and clears) a row naming the current owner as recipient', async () => {
      // This should be unreachable via the API (propose rejects AlreadyOwner and
      // owner changes clear the row); force the inconsistent state directly to
      // prove accept never promotes the sitting owner into a two-owner state.
      await groupDb.deleteFrom('pending_ownership_transfer').execute()
      await groupDb
        .insertInto('pending_ownership_transfer')
        .values({ id: 1, proposer_did: ADMIN, recipient_did: OWNER, expires_at: '2999-01-01' })
        .execute()

      const res = await as(OWNER).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('NoPendingTransfer')
      expect(await roleOf(OWNER)).toBe('owner')
      // The inconsistent row was cleared.
      expect(await pendingRow()).toBeUndefined()
    })
  })

  // --- cancel --------------------------------------------------------------

  describe('cancel', () => {
    beforeEach(async () => {
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })
    })

    it('the owner cancels their own proposal', async () => {
      const res = await as(OWNER).post(`/xrpc/${CANCEL}`).send({ repo: GROUP })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ groupDid: GROUP, cancelled: true })
      expect(await pendingRow()).toBeUndefined()
      expect(await roleOf(OWNER)).toBe('owner')
    })

    it('the proposed owner declines (cancels)', async () => {
      const res = await as(ADMIN).post(`/xrpc/${CANCEL}`).send({ repo: GROUP })

      expect(res.status).toBe(200)
      expect(res.body.cancelled).toBe(true)
      expect(await pendingRow()).toBeUndefined()
    })

    it('rejects cancellation by a non-party member', async () => {
      const res = await as(MEMBER).post(`/xrpc/${CANCEL}`).send({ repo: GROUP })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('NotPartyToTransfer')
      expect(await pendingRow()).toBeDefined()
    })

    it('rejects cancellation when nothing is pending', async () => {
      await groupDb.deleteFrom('pending_ownership_transfer').execute()
      const res = await as(OWNER).post(`/xrpc/${CANCEL}`).send({ repo: GROUP })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('NoPendingTransfer')
    })
  })

  // --- status --------------------------------------------------------------

  describe('status', () => {
    it('reports pending=false when nothing is proposed', async () => {
      const res = await as(MEMBER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ groupDid: GROUP, pending: false })
      expect(res.body.proposedOwner).toBeUndefined()
    })

    it('rejects a request with no repo (no group resolved)', async () => {
      const res = await as(MEMBER).get(`/xrpc/${STATUS}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('InvalidRequest')
    })

    describe('with a pending proposal', () => {
      beforeEach(async () => {
        await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })
      })

      it('discloses details to the current owner', async () => {
        const res = await as(OWNER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
          pending: true,
          proposedOwner: ADMIN,
          proposedBy: OWNER,
        })
      })

      it('discloses details to the proposed new owner', async () => {
        const res = await as(ADMIN).get(`/xrpc/${STATUS}`).query({ repo: GROUP })

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ pending: true, proposedOwner: ADMIN })
      })

      it('refuses details to a non-party member (does not leak the transfer)', async () => {
        const res = await as(MEMBER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })

        expect(res.status).toBe(403)
        expect(res.body.error).toBe('NotPartyToTransfer')
      })

      it('reports pending=false once the proposal has expired', async () => {
        await expirePending()
        const res = await as(OWNER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })

        expect(res.status).toBe(200)
        expect(res.body.pending).toBe(false)
      })
    })
  })

  // --- full lifecycle ------------------------------------------------------

  it('propose → status → accept → status completes the transfer', async () => {
    await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: MEMBER })

    let status = await as(MEMBER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })
    expect(status.body).toMatchObject({ pending: true, proposedOwner: MEMBER })

    const accept = await as(MEMBER).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })
    expect(accept.status).toBe(200)
    expect(await roleOf(MEMBER)).toBe('owner')
    expect(await roleOf(OWNER)).toBe('admin')

    // The former owner is now an admin — no longer a party, and nothing pending.
    status = await as(OWNER).get(`/xrpc/${STATUS}`).query({ repo: GROUP })
    expect(status.body.pending).toBe(false)
  })

  // --- stale-row invalidation (code-review findings #1, #2) ----------------
  //
  // A pending proposal must be dropped whenever ownership or a party's
  // membership changes by another route, so a dead proposal can't be resurrected
  // and clobber a legitimate later state.

  describe('a pending transfer is invalidated when a party changes underneath it', () => {
    beforeEach(async () => {
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })
      expect(await pendingRow()).toBeDefined()
    })

    it('member.remove of the proposed owner clears the pending transfer', async () => {
      // OWNER (owner) removes ADMIN (the recipient).
      const res = await as(OWNER)
        .post(`/xrpc/${MEMBER_REMOVE}`)
        .send({ repo: GROUP, memberDid: ADMIN })
      expect(res.status).toBe(200)
      expect(await pendingRow()).toBeUndefined()

      // Re-adding ADMIN must NOT revive the dead proposal — accept now fails.
      await seedMemberWithIndex(groupDb, globalDb as any, ADMIN, GROUP, 'member', OWNER)
      const accept = await as(ADMIN).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })
      expect(accept.status).toBe(404)
      expect(accept.body.error).toBe('NoPendingTransfer')
      expect(await roleOf(OWNER)).toBe('owner')
    })

    it('role.set on the proposed owner clears the pending transfer', async () => {
      const res = await as(OWNER)
        .post(`/xrpc/${ROLE_SET}`)
        .send({ repo: GROUP, memberDid: ADMIN, role: 'member' })
      expect(res.status).toBe(200)
      expect(await pendingRow()).toBeUndefined()
    })

    it('role.set on an unrelated member leaves the pending transfer intact', async () => {
      const res = await as(OWNER)
        .post(`/xrpc/${ROLE_SET}`)
        .send({ repo: GROUP, memberDid: MEMBER, role: 'admin' })
      expect(res.status).toBe(200)
      // MEMBER is not a party — the ADMIN proposal survives.
      expect(await pendingRow()).toMatchObject({ recipient_did: ADMIN })
    })
  })

  // --- API-key access ------------------------------------------------------
  //
  // The four methods must be reachable by API keys, not just service-auth JWTs.
  // This exercises the apiKey principal path end to end: the key's granted
  // scopes are checked against the operation (assertCanWithAudit), on top of the
  // issuing member's role. Mirrors tests/api-key-scope-enforcement.test.ts.

  describe('API-key access', () => {
    const SERVICE_DID = 'did:web:test.example.com'
    const scopeFor = (op: Parameters<typeof scopeNeededFor>[0]) => scopeNeededFor(op, SERVICE_DID)!

    /** An AuthVerifier whose xrpcAuth() yields an apiKey principal for `callerDid`. */
    const keyAuth = (scopes: string[], callerDid: string) =>
      ({
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
      }) as any

    /** Rebuild the app bound to an apiKey verifier for `caller` with `scopes`. */
    const keyApp = (scopes: string[], callerDid: string): express.Express => {
      ctx.authVerifier = keyAuth(scopes, callerDid)
      return createTestApp(ctx, registerAll)
    }

    it('an owner key scoped to propose can propose (200)', async () => {
      const res = await request(keyApp([scopeFor('ownershipTransfer.propose')], OWNER))
        .post(`/xrpc/${PROPOSE}?repo=${GROUP}`)
        .send({ newOwner: ADMIN })

      expect(res.status).toBe(200)
      expect(res.body.proposedOwner).toBe(ADMIN)
      expect(await pendingRow()).toBeDefined()
    })

    it('a propose key without the propose scope is denied (403)', async () => {
      const res = await request(keyApp([scopeFor('ownershipTransfer.status')], OWNER))
        .post(`/xrpc/${PROPOSE}?repo=${GROUP}`)
        .send({ newOwner: ADMIN })

      expect(res.status).toBe(403)
      expect(await pendingRow()).toBeUndefined()
    })

    it('the proposed owner can accept via a key scoped to accept (200)', async () => {
      // Owner proposes ADMIN via a JWT first.
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })

      const res = await request(keyApp([scopeFor('ownershipTransfer.accept')], ADMIN))
        .post(`/xrpc/${ACCEPT}?repo=${GROUP}`)
        .send({})

      expect(res.status).toBe(200)
      expect(await roleOf(ADMIN)).toBe('owner')
      expect(await roleOf(OWNER)).toBe('admin')
    })

    it('a party can read status via a key scoped to status (200)', async () => {
      await as(OWNER).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })

      const res = await request(keyApp([scopeFor('ownershipTransfer.status')], OWNER)).get(
        `/xrpc/${STATUS}?repo=${GROUP}`,
      )

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ pending: true, proposedOwner: ADMIN })
    })

    it('an admin-issued key cannot propose — propose is owner-only, role caps the key (403)', async () => {
      const res = await request(keyApp([scopeFor('ownershipTransfer.propose')], ADMIN))
        .post(`/xrpc/${PROPOSE}?repo=${GROUP}`)
        .send({ newOwner: MEMBER })

      expect(res.status).toBe(403)
    })
  })
})

// Finding #1: the operator break-glass admin.setOwner must invalidate any
// member-initiated pending transfer, so a stale proposal by the (now demoted)
// owner cannot be accepted within its TTL and silently revert the reassignment.
describe('admin.setOwner clears a pending ownership transfer', () => {
  const NEWOWNER = 'did:plc:newowner1'
  let groupDb: Kysely<GroupDatabase>
  let globalDb: Kysely<GlobalDatabase>
  let ctx: AppContext
  let app: express.Express
  let caller: string

  const basic = (user: string, pass: string): string =>
    'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

  beforeEach(async () => {
    const tc = await createTestContext()
    groupDb = tc.groupDb
    globalDb = tc.globalDb
    ctx = tc.ctx
    caller = OWNER

    // JWT verifier (mutable caller) for propose, plus the admin verifier for setOwner.
    const resolveRepoToGroup = async (repo: string) => {
      if (repo === GROUP || repo === 'group.example.com') return GROUP
      const { AuthRequiredError } = await import('@atproto/xrpc-server')
      throw new AuthRequiredError('Unknown group')
    }
    ctx.authVerifier = {
      verify: async (req: any) => {
        const repo = typeof req?.query?.repo === 'string' ? req.query.repo : undefined
        const groupDid = repo !== undefined ? await resolveRepoToGroup(repo) : undefined
        return { iss: caller, groupDid, legacyAud: false }
      },
      resolveRepoToGroup,
      xrpcAuth() {
        return async ({ req }: { req: any }) => {
          const { iss, groupDid, legacyAud } = await this.verify(req)
          return { credentials: { callerDid: iss, groupDid, legacyAud, authKind: 'jwt' } }
        }
      },
      xrpcAdminAuth() {
        return mockAdminVerifier()
      },
    } as any

    app = createTestApp(ctx, (server, appCtx) => {
      proposeHandler(server, appCtx)
      acceptHandler(server, appCtx)
      adminSetOwnerHandler(server, appCtx)
    })

    await seedMemberWithIndex(groupDb, globalDb, OWNER, GROUP, 'owner')
    await seedMemberWithIndex(groupDb, globalDb, ADMIN, GROUP, 'admin')
    await seedMemberWithIndex(groupDb, globalDb, NEWOWNER, GROUP, 'member')
  })

  afterEach(async () => {
    await groupDb.destroy()
    await globalDb.destroy()
  })

  const roleOf = async (did: string) =>
    (
      await groupDb
        .selectFrom('group_members')
        .select('role')
        .where('member_did', '=', did)
        .executeTakeFirst()
    )?.role

  it('a stale proposal cannot revert an operator reassignment', async () => {
    // 1. The (soon-to-be-replaced) owner proposes ADMIN.
    caller = OWNER
    await request(app).post(`/xrpc/${PROPOSE}`).send({ repo: GROUP, newOwner: ADMIN })

    // 2. Operator installs NEWOWNER via break-glass. OWNER is demoted.
    const setOwner = await request(app)
      .post('/xrpc/app.certified.group.admin.setOwner')
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send({ repo: GROUP, newOwner: NEWOWNER })
    expect(setOwner.status).toBe(200)
    expect(await roleOf(NEWOWNER)).toBe('owner')

    // 3. The pending row is gone — ADMIN can no longer accept and clobber NEWOWNER.
    caller = ADMIN
    const accept = await request(app).post(`/xrpc/${ACCEPT}`).send({ repo: GROUP })
    expect(accept.status).toBe(404)
    expect(accept.body.error).toBe('NoPendingTransfer')
    expect(await roleOf(NEWOWNER)).toBe('owner')
    expect(await roleOf(ADMIN)).toBe('admin')
  })
})
