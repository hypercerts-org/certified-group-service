import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { GroupDatabase } from '../src/db/schema.js'
import { createTestGroupDb } from './helpers/test-db.js'
import { PendingTransferStore, PENDING_TRANSFER_TTL_SECONDS } from '../src/transfer/pending.js'

const PROPOSER = 'did:plc:proposer'
const RECIPIENT = 'did:plc:recipient'

describe('PendingTransferStore', () => {
  let groupDb: Kysely<GroupDatabase>
  let store: PendingTransferStore

  beforeEach(async () => {
    const { db } = await createTestGroupDb()
    groupDb = db
    store = new PendingTransferStore()
  })

  afterEach(async () => {
    await groupDb.destroy()
  })

  it('returns null when nothing is stored', async () => {
    expect(await store.get(groupDb)).toBeNull()
  })

  it('propose stores a row and get reads it back', async () => {
    const stored = await store.propose(groupDb, PROPOSER, RECIPIENT)
    expect(stored).toMatchObject({ proposerDid: PROPOSER, recipientDid: RECIPIENT })
    expect(stored.createdAt).toBeDefined()
    expect(stored.expiresAt).toBeDefined()

    const read = await store.get(groupDb)
    expect(read).toMatchObject({ proposerDid: PROPOSER, recipientDid: RECIPIENT })
  })

  it('expiry is TTL seconds after creation', async () => {
    const stored = await store.propose(groupDb, PROPOSER, RECIPIENT)
    const created = new Date(stored.createdAt + 'Z').getTime()
    const expires = new Date(stored.expiresAt + 'Z').getTime()
    expect(Math.round((expires - created) / 1000)).toBe(PENDING_TRANSFER_TTL_SECONDS)
  })

  it('a second propose replaces the first (single pinned row)', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.propose(groupDb, PROPOSER, 'did:plc:other')

    const rows = await groupDb.selectFrom('pending_ownership_transfer').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].recipient_did).toBe('did:plc:other')
    expect(rows[0].id).toBe(1)
  })

  it('get treats an expired row as absent (lazy expiry)', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await groupDb
      .updateTable('pending_ownership_transfer')
      .set({ expires_at: sql`datetime('now', '-1 seconds')` })
      .execute()

    expect(await store.get(groupDb)).toBeNull()
    // The row still physically exists — expiry is enforced on read, not swept.
    const rows = await groupDb.selectFrom('pending_ownership_transfer').selectAll().execute()
    expect(rows).toHaveLength(1)
  })

  it('clear removes the row', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.clear(groupDb)
    expect(await store.get(groupDb)).toBeNull()
    const rows = await groupDb.selectFrom('pending_ownership_transfer').selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it('clearIfParty removes the row when the DID is the proposer', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.clearIfParty(groupDb, PROPOSER)
    expect(await store.get(groupDb)).toBeNull()
  })

  it('clearIfParty removes the row when the DID is the recipient', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.clearIfParty(groupDb, RECIPIENT)
    expect(await store.get(groupDb)).toBeNull()
  })

  it('clearIfParty leaves the row when the DID is not a party', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.clearIfParty(groupDb, 'did:plc:bystander')
    expect(await store.get(groupDb)).not.toBeNull()
  })

  it('clearIfMatches removes the row and returns true on an exact pair match', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    const matched = await store.clearIfMatches(groupDb, PROPOSER, RECIPIENT)
    expect(matched).toBe(true)
    expect(await store.get(groupDb)).toBeNull()
  })

  it('clearIfMatches leaves a replaced proposal intact and returns false', async () => {
    // Simulate a concurrent propose replacing the row after it was read: the
    // original pair no longer matches, so the newer proposal must survive.
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await store.propose(groupDb, PROPOSER, 'did:plc:newrecipient')
    const matched = await store.clearIfMatches(groupDb, PROPOSER, RECIPIENT)
    expect(matched).toBe(false)
    const surviving = await store.get(groupDb)
    expect(surviving?.recipientDid).toBe('did:plc:newrecipient')
  })

  it('rejects a second physical row (single-row CHECK invariant)', async () => {
    await store.propose(groupDb, PROPOSER, RECIPIENT)
    await expect(
      groupDb
        .insertInto('pending_ownership_transfer')
        .values({
          id: 2,
          proposer_did: PROPOSER,
          recipient_did: RECIPIENT,
          expires_at: '2999-01-01',
        })
        .execute(),
    ).rejects.toThrow()
  })
})
