import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import {
  createTestContext,
  createTestApp,
  seedAuthorship,
  TEST_ADMIN_PASSWORD,
} from './helpers/mock-server.js'
import adminBackfillHandler from '../src/api/admin/backfillAuthorship.js'
import { AUTHORSHIP_COLLECTION, authorshipRkey } from '../src/authorship.js'
import type { AppContext } from '../src/context.js'

const NSID = 'app.certified.group.admin.backfillAuthorship'
const GROUP = 'did:plc:testgroup'
const POST = 'app.bsky.feed.post'

const basic = (user: string, pass: string): string =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

/**
 * A pdsAgents mock for the backfill: `existingSidecarRkeys` are returned by
 * listRecords (paged, `pageSize` per page) and every applyWrites call is
 * recorded.
 */
function backfillPdsAgents(existingSidecarRkeys: string[], pageSize = 100) {
  const applyWritesCalls: any[] = []
  const agent = {
    com: {
      atproto: {
        repo: {
          listRecords: async (params: { cursor?: string }) => {
            const start = params.cursor !== undefined ? parseInt(params.cursor, 10) : 0
            const page = existingSidecarRkeys.slice(start, start + pageSize)
            const next = start + page.length
            return {
              data: {
                records: page.map((rkey) => ({
                  uri: `at://${GROUP}/${AUTHORSHIP_COLLECTION}/${rkey}`,
                  value: {},
                })),
                ...(next < existingSidecarRkeys.length ? { cursor: String(next) } : {}),
              },
            }
          },
          applyWrites: async (input: any) => {
            applyWritesCalls.push(input)
            return { data: { commit: { cid: 'bafycommit', rev: '3rev' }, results: [] } }
          },
        },
      },
    },
  }
  const pdsAgents = {
    get: async () => agent,
    withAgent: async (_did: string, fn: (a: any) => Promise<any>) => fn(agent),
    invalidate: () => {},
  }
  return { applyWritesCalls, pdsAgents: pdsAgents as unknown as AppContext['pdsAgents'] }
}

describe('admin.backfillAuthorship', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let app: express.Express

  beforeEach(async () => {
    const tc = await createTestContext()
    ctx = tc.ctx
    groupDb = tc.groupDb
    app = createTestApp(ctx, (server, appCtx) => {
      adminBackfillHandler(server, appCtx)
    })
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  const post = (body: object) =>
    request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', TEST_ADMIN_PASSWORD))
      .send(body)

  it('writes sidecars for tracked rows that lack one, skipping existing', async () => {
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/aaa`, 'did:plc:alice', POST)
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/bbb`, 'did:plc:bob', POST)
    // aaa already has a sidecar in the repo; bbb does not
    const recorder = backfillPdsAgents([authorshipRkey(POST, 'aaa')])
    ctx.pdsAgents = recorder.pdsAgents

    const res = await post({ repo: GROUP })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      groupDid: GROUP,
      created: 1,
      alreadyPresent: 1,
      total: 2,
    })

    expect(recorder.applyWritesCalls).toHaveLength(1)
    const { writes } = recorder.applyWritesCalls[0]
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      collection: AUTHORSHIP_COLLECTION,
      rkey: authorshipRkey(POST, 'bbb'),
    })
    expect(writes[0].value).toMatchObject({
      $type: AUTHORSHIP_COLLECTION,
      subject: `at://${GROUP}/${POST}/bbb`,
      author: 'did:plc:bob',
    })
    // createdAt preserved from the tracked row (ISO format)
    expect(Date.parse(writes[0].value.createdAt)).not.toBeNaN()

    // Audit-logged as actor `admin`
    const audit = await groupDb.selectFrom('group_audit_log').selectAll().execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actor_did: 'admin',
      action: 'admin.backfillAuthorship',
      result: 'permitted',
    })
  })

  it('is a no-op when every row already has a sidecar', async () => {
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/aaa`, 'did:plc:alice', POST)
    const recorder = backfillPdsAgents([authorshipRkey(POST, 'aaa')])
    ctx.pdsAgents = recorder.pdsAgents

    const res = await post({ repo: GROUP })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ created: 0, alreadyPresent: 1, total: 1 })
    expect(recorder.applyWritesCalls).toHaveLength(0)
  })

  it('paginates the existing-sidecar listing', async () => {
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/new1`, 'did:plc:alice', POST)
    // 5 existing sidecars served 2 per page → 3 pages; none match new1
    const existing = ['r1', 'r2', 'r3', 'r4', 'r5'].map((r) => authorshipRkey(POST, r))
    const recorder = backfillPdsAgents(existing, 2)
    ctx.pdsAgents = recorder.pdsAgents

    const res = await post({ repo: GROUP })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ created: 1, alreadyPresent: 5, total: 1 })
  })

  it('chunks large backfills into 200-write commits', async () => {
    const values = Array.from({ length: 201 }, (_, i) => ({
      record_uri: `at://${GROUP}/${POST}/rk${i}`,
      author_did: 'did:plc:alice',
      collection: POST,
    }))
    await groupDb.insertInto('group_record_authors').values(values).execute()
    const recorder = backfillPdsAgents([])
    ctx.pdsAgents = recorder.pdsAgents

    const res = await post({ repo: GROUP })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ created: 201, alreadyPresent: 0, total: 201 })
    expect(recorder.applyWritesCalls).toHaveLength(2)
    expect(recorder.applyWritesCalls[0].writes).toHaveLength(200)
    expect(recorder.applyWritesCalls[1].writes).toHaveLength(1)
  })

  it('rejects a missing Authorization header', async () => {
    const res = await request(app).post(`/xrpc/${NSID}`).send({ repo: GROUP })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong admin password', async () => {
    const res = await request(app)
      .post(`/xrpc/${NSID}`)
      .set('Authorization', basic('admin', 'wrong-password'))
      .send({ repo: GROUP })
    expect(res.status).toBe(401)
  })

  it('404s an unknown group', async () => {
    const res = await post({ repo: 'did:plc:unknowngroup' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('UnknownGroup')
  })

  it('surfaces unexpected resolver failures as-is (not UnknownGroup)', async () => {
    ctx.authVerifier = {
      ...ctx.authVerifier,
      resolveRepoToGroup: async () => {
        throw new Error('resolver down')
      },
    } as unknown as AppContext['authVerifier']
    // Re-register handlers against the patched verifier
    app = createTestApp(ctx, (server, appCtx) => {
      adminBackfillHandler(server, appCtx)
    })

    const res = await post({ repo: GROUP })
    expect(res.status).toBe(500)
  })
})
