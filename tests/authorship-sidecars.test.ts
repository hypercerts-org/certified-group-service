/**
 * Authorship sidecar behavior of the record endpoints: every create writes an
 * app.certified.group.authorship record into the group repo (atomically with
 * the subject record where possible), deletes clean the sidecar up, and the
 * sidecar collection itself is service-managed (direct writes rejected).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { XRPCError as ClientXRPCError } from '@atproto/xrpc'
import {
  createTestContext,
  createTestApp,
  seedMember,
  seedAuthorship,
} from './helpers/mock-server.js'
import createRecordHandler from '../src/api/repo/createRecord.js'
import putRecordHandler from '../src/api/repo/putRecord.js'
import deleteRecordHandler from '../src/api/repo/deleteRecord.js'
import { AUTHORSHIP_COLLECTION } from '../src/authorship.js'
import type { AppContext } from '../src/context.js'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'

const GROUP = 'did:plc:testgroup'
const CALLER = 'did:plc:testuser'
const POST = 'app.bsky.feed.post'

interface RecordedCall {
  method: string
  input: any
}

/**
 * A pdsAgents mock that records every repo call. `recordExists` controls the
 * getRecord probe (false → RecordNotFound); `failSidecarOps` makes writes and
 * deletes of the authorship collection throw (to exercise best-effort paths);
 * `getRecordFails` makes the probe throw a non-RecordNotFound error;
 * `applyWritesEmptyResults` / `noCommit` shape degenerate PDS responses.
 */
function recordingPdsAgents(
  opts: {
    recordExists?: boolean
    failSidecarOps?: boolean
    getRecordFails?: boolean
    applyWritesEmptyResults?: boolean
    noCommit?: boolean
  } = {},
) {
  const calls: RecordedCall[] = []
  const agent = {
    com: {
      atproto: {
        repo: {
          createRecord: async (input: any) => {
            calls.push({ method: 'createRecord', input })
            if (opts.failSidecarOps && input.collection === AUTHORSHIP_COLLECTION) {
              throw new ClientXRPCError(500, 'InternalServerError', 'boom')
            }
            return {
              data: {
                uri: `at://${GROUP}/${input.collection}/${input.rkey ?? 'generated'}`,
                cid: 'bafytest',
              },
            }
          },
          putRecord: async (input: any) => {
            calls.push({ method: 'putRecord', input })
            return {
              data: { uri: `at://${GROUP}/${input.collection}/${input.rkey}`, cid: 'bafytest' },
            }
          },
          deleteRecord: async (input: any) => {
            calls.push({ method: 'deleteRecord', input })
            if (opts.failSidecarOps && input.collection === AUTHORSHIP_COLLECTION) {
              throw new ClientXRPCError(500, 'InternalServerError', 'boom')
            }
            return { data: {} }
          },
          getRecord: async (input: any) => {
            calls.push({ method: 'getRecord', input })
            if (opts.getRecordFails) {
              throw new ClientXRPCError(400, 'InvalidRequest', 'probe exploded')
            }
            if (opts.recordExists) {
              return { data: { uri: `at://${GROUP}/${input.collection}/${input.rkey}` } }
            }
            throw new ClientXRPCError(400, 'RecordNotFound', 'Could not locate record')
          },
          applyWrites: async (input: any) => {
            calls.push({ method: 'applyWrites', input })
            return {
              data: {
                ...(opts.noCommit ? {} : { commit: { cid: 'bafycommit', rev: '3testrev' } }),
                results: opts.applyWritesEmptyResults
                  ? []
                  : input.writes.map((w: any) =>
                      w.$type === 'com.atproto.repo.applyWrites#delete'
                        ? { $type: 'com.atproto.repo.applyWrites#deleteResult' }
                        : {
                            $type: `${w.$type}Result`,
                            uri: `at://${GROUP}/${w.collection}/${w.rkey ?? 'generated'}`,
                            cid: 'bafytest',
                            validationStatus: 'unknown',
                          },
                    ),
              },
            }
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
  return { calls, pdsAgents: pdsAgents as unknown as AppContext['pdsAgents'] }
}

describe('createRecord — authorship sidecar', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>
  let calls: RecordedCall[]

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    const recorder = recordingPdsAgents()
    calls = recorder.calls
    ctx.pdsAgents = recorder.pdsAgents
    await seedMember(groupDb, CALLER, 'member')
  })

  const app = () => createTestApp(ctx, (s, c) => createRecordHandler(s, c))

  it('writes the record and its sidecar in ONE applyWrites commit', async () => {
    const res = await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'post1', record: { text: 'hello' } })

    expect(res.status).toBe(200)
    expect(res.body.uri).toBe(`at://${GROUP}/${POST}/post1`)
    expect(res.body.cid).toBe('bafytest')
    // Commit meta and validationStatus propagated from the applyWrites result
    expect(res.body.commit).toMatchObject({ cid: 'bafycommit' })
    expect(res.body.validationStatus).toBe('unknown')

    expect(calls.map((c) => c.method)).toEqual(['applyWrites'])
    const { writes } = calls[0].input
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ collection: POST, rkey: 'post1', value: { text: 'hello' } })
    expect(writes[1]).toMatchObject({
      collection: AUTHORSHIP_COLLECTION,
      rkey: `${POST}:post1`,
    })
    expect(writes[1].value).toMatchObject({
      $type: AUTHORSHIP_COLLECTION,
      subject: `at://${GROUP}/${POST}/post1`,
      author: CALLER,
    })
    expect(Date.parse(writes[1].value.createdAt)).not.toBeNaN()
    expect('via' in writes[1].value).toBe(false)
  })

  it('mints a TID rkey when none is supplied and embeds it in the sidecar subject', async () => {
    const res = await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, record: { text: 'hi' } })

    expect(res.status).toBe(200)
    const { writes } = calls[0].input
    const rkey = writes[0].rkey
    expect(rkey).toBeTruthy()
    expect(res.body.uri).toBe(`at://${GROUP}/${POST}/${rkey}`)
    expect(writes[1].rkey).toBe(`${POST}:${rkey}`)
    expect(writes[1].value.subject).toBe(`at://${GROUP}/${POST}/${rkey}`)
  })

  it('records the API key ref in the sidecar via field', async () => {
    ctx.authVerifier = {
      ...ctx.authVerifier,
      xrpcAuth() {
        return async () => ({
          credentials: {
            callerDid: CALLER,
            groupDid: GROUP,
            legacyAud: false,
            authKind: 'apiKey' as const,
            scopes: [`repo:${POST}?action=create`],
            apiKeyRef: 'ref1',
          },
        })
      },
    } as unknown as AppContext['authVerifier']

    const res = await request(app())
      .post(`/xrpc/com.atproto.repo.createRecord?repo=${GROUP}`)
      .send({ repo: GROUP, collection: POST, rkey: 'bot1', record: { text: 'beep' } })

    expect(res.status).toBe(200)
    expect(calls[0].input.writes[1].value.via).toBe('ref1')
  })

  it('passes validate:false through but degrades validate:true to default', async () => {
    await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'a', record: {}, validate: false })
    expect(calls[0].input.validate).toBe(false)

    await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'b', record: {}, validate: true })
    expect('validate' in calls[1].input).toBe(false)
  })

  it('rejects direct writes to the authorship collection', async () => {
    const res = await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({
        repo: GROUP,
        collection: AUTHORSHIP_COLLECTION,
        record: { subject: 'at://x/y/z', author: 'did:plc:forged' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidRequest')
    expect(calls).toHaveLength(0)
  })

  it('502s when the PDS returns no applyWrites result for the record', async () => {
    const recorder = recordingPdsAgents({ applyWritesEmptyResults: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'x', record: {} })

    expect(res.status).toBe(502)
  })

  it('omits commit meta when the PDS response has none', async () => {
    const recorder = recordingPdsAgents({ noCommit: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.createRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'y', record: {} })

    expect(res.status).toBe(200)
    expect('commit' in res.body).toBe(false)
  })
})

describe('putRecord — authorship sidecar', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, CALLER, 'member')
  })

  const app = () => createTestApp(ctx, (s, c) => putRecordHandler(s, c))

  it('genuinely new record: writes record + sidecar in one applyWrites commit', async () => {
    const recorder = recordingPdsAgents({ recordExists: false })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'new1', record: { text: 'x' } })

    expect(res.status).toBe(200)
    expect(recorder.calls.map((c) => c.method)).toEqual(['getRecord', 'applyWrites'])
    const { writes } = recorder.calls[1].input
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ collection: AUTHORSHIP_COLLECTION, rkey: `${POST}:new1` })
    expect(writes[1].value).toMatchObject({
      subject: `at://${GROUP}/${POST}/new1`,
      author: CALLER,
    })
  })

  it('legacy record (exists on PDS, untracked): putRecord then best-effort sidecar', async () => {
    const recorder = recordingPdsAgents({ recordExists: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'old1', record: { text: 'edited' } })

    expect(res.status).toBe(200)
    expect(recorder.calls.map((c) => c.method)).toEqual(['getRecord', 'putRecord', 'createRecord'])
    const sidecarCall = recorder.calls[2].input
    expect(sidecarCall.collection).toBe(AUTHORSHIP_COLLECTION)
    expect(sidecarCall.rkey).toBe(`${POST}:old1`)
    expect(sidecarCall.record).toMatchObject({
      subject: `at://${GROUP}/${POST}/old1`,
      author: CALLER,
    })
    // The edit attributes the record to the caller (existing semantics)
    const rows = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].author_did).toBe(CALLER)
  })

  it('legacy-record sidecar failure does not fail the request', async () => {
    const recorder = recordingPdsAgents({ recordExists: true, failSidecarOps: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'old2', record: { text: 'edited' } })

    expect(res.status).toBe(200)
  })

  it('propagates commit and validationStatus on the applyWrites path', async () => {
    const recorder = recordingPdsAgents({ recordExists: false })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'new2', record: {} })

    expect(res.status).toBe(200)
    expect(res.body.commit).toMatchObject({ cid: 'bafycommit' })
    expect(res.body.validationStatus).toBe('unknown')
  })

  it('surfaces a non-RecordNotFound probe failure instead of guessing', async () => {
    const recorder = recordingPdsAgents({ getRecordFails: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'new3', record: {} })

    // The probe's 4xx is forwarded; no write was attempted
    expect(res.status).toBe(400)
    expect(recorder.calls.map((c) => c.method)).toEqual(['getRecord'])
  })

  it('502s when the PDS returns no applyWrites result for a new record', async () => {
    const recorder = recordingPdsAgents({ applyWritesEmptyResults: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'new4', record: {} })

    expect(res.status).toBe(502)
  })

  it('omits commit meta when the PDS response has none (new record)', async () => {
    const recorder = recordingPdsAgents({ noCommit: true })
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'new5', record: {} })

    expect(res.status).toBe(200)
    expect('commit' in res.body).toBe(false)
  })

  it('tracked record update: plain putRecord, sidecar untouched', async () => {
    const recorder = recordingPdsAgents()
    ctx.pdsAgents = recorder.pdsAgents
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/xyz`, CALLER, POST)

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'xyz', record: { text: 'v2' } })

    expect(res.status).toBe(200)
    expect(recorder.calls.map((c) => c.method)).toEqual(['putRecord'])
    // Authorship remains with the original author
    const rows = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].author_did).toBe(CALLER)
  })

  it('rejects direct writes to the authorship collection', async () => {
    const recorder = recordingPdsAgents()
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.putRecord')
      .send({
        repo: GROUP,
        collection: AUTHORSHIP_COLLECTION,
        rkey: `${POST}:post1`,
        record: { subject: `at://${GROUP}/${POST}/post1`, author: 'did:plc:forged' },
      })

    expect(res.status).toBe(400)
    expect(recorder.calls).toHaveLength(0)
  })
})

describe('deleteRecord — authorship sidecar', () => {
  let ctx: AppContext
  let groupDb: Kysely<GroupDatabase>

  beforeEach(async () => {
    const test = await createTestContext()
    ctx = test.ctx
    groupDb = test.groupDb
    await seedMember(groupDb, CALLER, 'member')
  })

  const app = () => createTestApp(ctx, (s, c) => deleteRecordHandler(s, c))

  it('deletes the sidecar after the subject record', async () => {
    const recorder = recordingPdsAgents()
    ctx.pdsAgents = recorder.pdsAgents
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/abc`, CALLER, POST)

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'abc' })

    expect(res.status).toBe(200)
    expect(recorder.calls.map((c) => c.method)).toEqual(['deleteRecord', 'deleteRecord'])
    expect(recorder.calls[0].input).toMatchObject({ collection: POST, rkey: 'abc' })
    expect(recorder.calls[1].input).toMatchObject({
      collection: AUTHORSHIP_COLLECTION,
      rkey: `${POST}:abc`,
    })
  })

  it('sidecar deletion failure does not fail the request', async () => {
    const recorder = recordingPdsAgents({ failSidecarOps: true })
    ctx.pdsAgents = recorder.pdsAgents
    await seedAuthorship(groupDb, `at://${GROUP}/${POST}/abc`, CALLER, POST)

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: GROUP, collection: POST, rkey: 'abc' })

    expect(res.status).toBe(200)
    // Subject-side cleanup still happened
    const rows = await groupDb.selectFrom('group_record_authors').selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it('rejects direct deletes of authorship records', async () => {
    const recorder = recordingPdsAgents()
    ctx.pdsAgents = recorder.pdsAgents

    const res = await request(app())
      .post('/xrpc/com.atproto.repo.deleteRecord')
      .send({ repo: GROUP, collection: AUTHORSHIP_COLLECTION, rkey: `${POST}:abc` })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('InvalidRequest')
    expect(recorder.calls).toHaveLength(0)
  })
})
