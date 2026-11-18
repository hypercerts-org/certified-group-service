import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createTestContext, createTestApp, seedMember } from './helpers/mock-server.js'
import createRecord from '../src/api/repo/createRecord.js'
import putRecord from '../src/api/repo/putRecord.js'
import deleteRecord from '../src/api/repo/deleteRecord.js'

const GROUP_DID = 'did:plc:testgroup'
const CID = 'bafyreibdrw2ps37hvyuahejlzuhe3zqcy4hpf7ark2fuyffglaqpr3ekxu'
const base = { repo: GROUP_DID, collection: 'app.bsky.feed.post' }
const record = { $type: 'app.bsky.feed.post', text: 'hi', createdAt: '2026-01-01T00:00:00Z' }

describe('swapRecord / swapCommit on app.certified.group.repo.*', () => {
  let app: Express
  let forwarded: Record<string, unknown> | undefined

  beforeEach(async () => {
    forwarded = undefined
    const { ctx, groupDb } = await createTestContext()
    await seedMember(groupDb, 'did:plc:testuser', 'owner')
    const capture = async (input: Record<string, unknown>) => {
      forwarded = input
      return { data: { uri: `at://${GROUP_DID}/app.bsky.feed.post/k`, cid: CID } }
    }
    ctx.pdsAgents = {
      withAgent: async (_did: string, fn: (a: unknown) => unknown) =>
        fn({
          com: {
            atproto: { repo: { createRecord: capture, putRecord: capture, deleteRecord: capture } },
          },
        }),
    } as never
    app = createTestApp(ctx, (s, c) => {
      createRecord(s, c)
      putRecord(s, c)
      deleteRecord(s, c)
    })
  })

  const post = (method: string, body: object) =>
    request(app).post(`/xrpc/app.certified.group.repo.${method}`).send(body)

  it.each([
    ['createRecord', { ...base, record, swapCommit: CID }],
    ['putRecord', { ...base, rkey: 'k', record, swapRecord: CID, swapCommit: CID }],
    ['putRecord', { ...base, rkey: 'k', record, swapRecord: null }],
    ['deleteRecord', { ...base, rkey: 'k', swapRecord: CID, swapCommit: CID }],
  ])('%s forwards swap fields to the PDS unchanged', async (method, body) => {
    const res = await post(method, body)
    expect(res.status).toBe(200)
    expect(forwarded).toMatchObject({ ...body, repo: GROUP_DID })
    for (const key of ['swapRecord', 'swapCommit'] as const) {
      if (key in body) expect(forwarded).toHaveProperty(key, (body as Record<string, unknown>)[key])
    }
  })

  it.each([
    ['createRecord', { ...base, record, swapCommit: 'not-a-cid' }],
    ['putRecord', { ...base, rkey: 'k', record, swapRecord: 'not-a-cid' }],
    ['deleteRecord', { ...base, rkey: 'k', swapCommit: 'not-a-cid' }],
  ])('%s rejects a malformed swap CID with 400 before reaching the PDS', async (method, body) => {
    const res = await post(method, body)
    expect(res.status).toBe(400)
    expect(forwarded).toBeUndefined()
  })

  it('deleteRecord does not accept null swapRecord (only putRecord declares it nullable)', async () => {
    const res = await post('deleteRecord', { ...base, rkey: 'k', swapRecord: null })
    expect(res.status).toBe(400)
  })
})
