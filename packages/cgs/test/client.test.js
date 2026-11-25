// Loads the built package by its name, as a consumer would. No network access.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client, XrpcResponseValidationError } from '@atproto/lex'
import * as cgs from '@hypercerts-org/cgs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cgsLexiconsRoot = path.resolve(packageRoot, '../../lexicons/app')

/**
 * @param {unknown} body
 * @param {(request: Request) => void} [onRequest]
 * @returns {typeof globalThis.fetch}
 */
const stubFetch = (body, onRequest) => async (input, init) => {
  onRequest?.(new Request(input, init))
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/**
 * Follows an NSID through lex's namespace tree: app.certified.group.repo.putRecord.
 * @param {object} root
 * @param {string} nsid
 * @returns {any}
 */
const lookup = (root, nsid) =>
  nsid.split('.').reduce((node, part) => /** @type {any} */ (node)?.[part], root)

test('every CGS-owned Lexicon under lexicons/app/ is at its NSID path', async () => {
  const entries = await readdir(cgsLexiconsRoot, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(entry.parentPath, entry.name))
  assert.ok(files.length > 0)

  for (const file of files) {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(
      lookup(cgs, doc.id)?.main?.nsid,
      doc.id,
      `${doc.id} should be exported at its NSID`,
    )
  }

  // Deprecated com.atproto.repo.* proxy stubs must not be exported.
  assert.equal('com' in cgs, false)
})

test('membership.list validates responses against the Lexicon', async () => {
  const group = {
    groupDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    role: 'admin',
    joinedAt: '2026-11-01T00:00:00.000Z',
  }
  const valid = new Client({
    service: 'https://groups.example',
    fetch: stubFetch({ groups: [group], cursor: 'next' }),
  })
  const result = await valid.call(cgs.app.certified.groups.membership.list, { limit: 50 })
  assert.deepEqual(result, { groups: [group], cursor: 'next' })

  const invalid = new Client({
    service: 'https://groups.example',
    fetch: stubFetch({ groups: [{ ...group, groupDid: 42 }] }),
  })
  await assert.rejects(
    invalid.call(cgs.app.certified.groups.membership.list, { limit: 50 }),
    XrpcResponseValidationError,
  )
})

test('repo.putRecord sends swapRecord and returns typed uri and cid', async () => {
  /** @type {Request | undefined} */
  let seen
  const response = {
    uri: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.certified.actor.profile/self',
    cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
  }
  const client = new Client({
    service: 'https://groups.example',
    fetch: stubFetch(response, (req) => {
      seen = req
    }),
  })
  const out = await client.call(cgs.app.certified.group.repo.putRecord, {
    repo: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    collection: 'app.certified.actor.profile',
    rkey: 'self',
    record: { $type: 'app.certified.actor.profile', displayName: 'Example Org' },
    swapRecord: null,
  })
  assert.deepEqual(out, response)
  assert.equal(seen?.method, 'POST')
  assert.equal(seen?.url, 'https://groups.example/xrpc/app.certified.group.repo.putRecord')
})

test('repo.uploadBlob sends raw bytes with repo query param and validates blob output', async () => {
  /** @type {Request | undefined} */
  let seen
  const cid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
  const client = new Client({
    service: 'https://groups.example',
    fetch: stubFetch(
      {
        blob: {
          $type: 'blob',
          ref: { $link: cid },
          mimeType: 'image/png',
          size: 4,
        },
      },
      (req) => {
        seen = req
      },
    ),
  })
  const { blob } = await client.call(
    cgs.app.certified.group.repo.uploadBlob,
    new Uint8Array([1, 2, 3, 4]),
    {
      params: { repo: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
      encoding: 'image/png',
    },
  )
  assert.equal(blob.mimeType, 'image/png')
  assert.ok('$type' in blob && blob.$type === 'blob')
  assert.equal(blob.size, 4)
  assert.equal(
    seen?.url,
    'https://groups.example/xrpc/app.certified.group.repo.uploadBlob?repo=did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa',
  )
})
