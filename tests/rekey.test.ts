import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Kysely } from 'kysely'
import { createTestGlobalDb } from './helpers/test-db.js'
import { decrypt, encrypt } from '../src/pds/credentials.js'
import {
  EncryptionKeyMismatchError,
  RekeyError,
  assertSecretsReadable,
  rekeyGroupSecrets,
  type GroupSecretColumn,
} from '../src/pds/rekey.js'
import type { GlobalDatabase } from '../src/db/schema.js'

const oldKey = randomBytes(32)
const newKey = randomBytes(32)
const unknownKey = randomBytes(32)
const keys = { oldKey, newKey }

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

describe('rekeyGroupSecrets', () => {
  let db: Kysely<GlobalDatabase>
  let raw: Database.Database

  beforeEach(async () => {
    const test = await createTestGlobalDb()
    db = test.db
    raw = test.raw
  })

  afterEach(async () => {
    await db.destroy()
  })

  async function insertGroup(
    did: string,
    encryptedAppPassword: string,
    encryptedRecoveryKey: string | null,
  ): Promise<void> {
    await db
      .insertInto('groups')
      .values({
        did,
        pds_url: 'https://pds.example.com',
        encrypted_app_password: encryptedAppPassword,
        encrypted_recovery_key: encryptedRecoveryKey,
      })
      .execute()
  }

  function readSecrets() {
    return db
      .selectFrom('groups')
      .select(['did', 'encrypted_app_password', 'encrypted_recovery_key'])
      .orderBy('did')
      .execute()
  }

  describe('with rows under the old key, rows already under the new key, and a NULL recovery key', () => {
    let before: Awaited<ReturnType<typeof readSecrets>>
    let after: Awaited<ReturnType<typeof readSecrets>>
    let result: ReturnType<typeof rekeyGroupSecrets>

    const rowFor = (rows: typeof before, did: string) => rows.find((r) => r.did === did)!

    beforeEach(async () => {
      await insertGroup('did:plc:a-old', encrypt('a-app', oldKey), encrypt('a-recovery', oldKey))
      await insertGroup(
        'did:plc:b-current',
        encrypt('b-app', newKey),
        encrypt('b-recovery', newKey),
      )
      // One value per key in the same row: each ciphertext is judged on its own.
      await insertGroup('did:plc:c-split', encrypt('c-app', newKey), encrypt('c-recovery', oldKey))
      await insertGroup('did:plc:d-import', encrypt('d-app', oldKey), null)
      // An empty plaintext is a valid secret, not a failed decrypt: the old-key
      // value must be re-encrypted and the new-key value must count as current.
      await insertGroup('did:plc:e-empty', encrypt('', oldKey), encrypt('', newKey))

      before = await readSecrets()
      result = rekeyGroupSecrets(raw, keys)
      after = await readSecrets()
    })

    it('counts each ciphertext as re-encrypted or already current', () => {
      expect(result).toEqual({ groups: 5, rekeyed: 5, alreadyCurrent: 4 })
    })

    it('leaves every value readable under the new key and none under the old key', () => {
      const plaintexts: Record<string, [string, string | null]> = {
        'did:plc:a-old': ['a-app', 'a-recovery'],
        'did:plc:b-current': ['b-app', 'b-recovery'],
        'did:plc:c-split': ['c-app', 'c-recovery'],
        'did:plc:d-import': ['d-app', null],
        'did:plc:e-empty': ['', ''],
      }
      for (const [did, [appPassword, recoveryKey]] of Object.entries(plaintexts)) {
        const row = rowFor(after, did)
        expect(decrypt(row.encrypted_app_password, newKey)).toBe(appPassword)
        expect(() => decrypt(row.encrypted_app_password, oldKey)).toThrow()
        if (recoveryKey !== null) {
          expect(decrypt(row.encrypted_recovery_key!, newKey)).toBe(recoveryKey)
          expect(() => decrypt(row.encrypted_recovery_key!, oldKey)).toThrow()
        }
      }
    })

    it('does not rewrite values that were already under the new key', () => {
      // A fresh encrypt() uses a random IV, so a rewritten value would differ.
      expect(rowFor(after, 'did:plc:b-current')).toEqual(rowFor(before, 'did:plc:b-current'))
      expect(rowFor(after, 'did:plc:c-split').encrypted_app_password).toBe(
        rowFor(before, 'did:plc:c-split').encrypted_app_password,
      )
      expect(rowFor(after, 'did:plc:e-empty').encrypted_recovery_key).toBe(
        rowFor(before, 'did:plc:e-empty').encrypted_recovery_key,
      )
    })

    it('leaves a NULL recovery key NULL', () => {
      expect(rowFor(after, 'did:plc:d-import').encrypted_recovery_key).toBeNull()
    })
  })

  describe('when a value decrypts under neither key', () => {
    // Rows are processed in DID order, so a-ok is re-keyed inside the
    // transaction before b-bad fails. Rolling back must undo it.
    async function seedUnreadableGroup(column: GroupSecretColumn) {
      await insertGroup('did:plc:a-ok', encrypt('ok-app', oldKey), encrypt('ok-recovery', oldKey))
      const readable = (plaintext: string) => encrypt(plaintext, oldKey)
      const unreadable = (plaintext: string) => encrypt(plaintext, unknownKey)
      await insertGroup(
        'did:plc:b-bad',
        column === 'encrypted_app_password' ? unreadable('bad-app') : readable('bad-app'),
        column === 'encrypted_recovery_key' ? unreadable('bad-recovery') : readable('bad-recovery'),
      )
    }

    it.each(['encrypted_app_password', 'encrypted_recovery_key'] as const)(
      'throws RekeyError naming the DID and %s, and changes no row',
      async (column) => {
        await seedUnreadableGroup(column)
        const before = await readSecrets()

        const error = catchError(() => rekeyGroupSecrets(raw, keys))

        expect(error).toBeInstanceOf(RekeyError)
        expect(error).toMatchObject({ did: 'did:plc:b-bad', column })
        expect((error as RekeyError).message).toContain('did:plc:b-bad')
        expect((error as RekeyError).message).toContain(`groups.${column}`)
        // Nothing is half-rotated: not a-ok, and not b-bad's own readable value either.
        expect(await readSecrets()).toEqual(before)
      },
    )

    it('keeps keys, plaintext and ciphertext out of the error', async () => {
      await seedUnreadableGroup('encrypted_app_password')
      const stored = await readSecrets()

      const { message } = catchError(() => rekeyGroupSecrets(raw, keys)) as RekeyError

      const ciphertexts = stored
        .flatMap((r) => [r.encrypted_app_password, r.encrypted_recovery_key])
        .filter((value): value is string => value !== null)
      const mustNotLeak = [
        oldKey.toString('hex'),
        newKey.toString('hex'),
        unknownKey.toString('hex'),
        'bad-app',
        'ok-app',
        ...ciphertexts,
      ]
      for (const secret of mustNotLeak) expect(message).not.toContain(secret)
    })
  })

  it('is a no-op the second time', async () => {
    await insertGroup('did:plc:a', encrypt('a-app', oldKey), encrypt('a-recovery', oldKey))
    await insertGroup('did:plc:b', encrypt('b-app', oldKey), null)

    expect(rekeyGroupSecrets(raw, keys)).toEqual({ groups: 2, rekeyed: 3, alreadyCurrent: 0 })
    const afterFirst = await readSecrets()

    expect(rekeyGroupSecrets(raw, keys)).toEqual({ groups: 2, rekeyed: 0, alreadyCurrent: 3 })
    // Byte-identical: nothing was decrypted and re-encrypted again.
    expect(await readSecrets()).toEqual(afterFirst)
  })

  it('reports zero for an empty groups table', () => {
    expect(rekeyGroupSecrets(raw, keys)).toEqual({ groups: 0, rekeyed: 0, alreadyCurrent: 0 })
  })
})

describe('assertSecretsReadable', () => {
  let db: Kysely<GlobalDatabase>
  let raw: Database.Database

  beforeEach(async () => {
    const test = await createTestGlobalDb()
    db = test.db
    raw = test.raw
  })

  afterEach(async () => {
    await db.destroy()
  })

  /** Inserts a group whose secrets are encrypted under the given master keys. */
  async function insertGroup(
    did: string,
    underKey: { appPassword: Buffer; recoveryKey: Buffer | null },
  ) {
    await db
      .insertInto('groups')
      .values({
        did,
        pds_url: 'https://pds.example.com',
        encrypted_app_password: encrypt(`${did}-app`, underKey.appPassword),
        encrypted_recovery_key:
          underKey.recoveryKey === null ? null : encrypt(`${did}-recovery`, underKey.recoveryKey),
      })
      .execute()
  }

  it('throws when the key opens none of the app passwords, as after a cut-over that kept the old key', async () => {
    // Every row is already under the new key, but ENCRYPTION_KEY is still the old one.
    await insertGroup('did:plc:a', { appPassword: newKey, recoveryKey: newKey })
    await insertGroup('did:plc:b', { appPassword: newKey, recoveryKey: null })
    // A recovery key the old key can read does not count: nothing reads it at
    // runtime, so it cannot make a PDS login work.
    await insertGroup('did:plc:c', { appPassword: newKey, recoveryKey: oldKey })

    const error = catchError(() => assertSecretsReadable(raw, oldKey))

    expect(error).toBeInstanceOf(EncryptionKeyMismatchError)
    expect(error).toMatchObject({ groups: 3 })
    const { message } = error as EncryptionKeyMismatchError
    // What went wrong, and what to do about it.
    expect(message).toContain('0 of 3 readable')
    expect(message).toContain('ENCRYPTION_KEY must hold the value that was ENCRYPTION_KEY_NEXT')
    expect(message).toContain('docs/deployment.md#rotating-encryption_key')
    // Safe to print in a failed deploy.
    for (const secret of [oldKey, newKey, unknownKey].map((key) => key.toString('hex'))) {
      expect(message).not.toContain(secret)
    }
  })

  it('passes when at least one app password is readable, however many are not', async () => {
    // One corrupt or foreign row must not stop the service from starting. The
    // readable row is neither first nor last, so every row has to be considered.
    await insertGroup('did:plc:a', { appPassword: unknownKey, recoveryKey: null })
    await insertGroup('did:plc:b', { appPassword: newKey, recoveryKey: null })
    await insertGroup('did:plc:c', { appPassword: unknownKey, recoveryKey: null })

    expect(() => assertSecretsReadable(raw, newKey)).not.toThrow()
  })

  it('passes for an empty groups table, as on a fresh install', () => {
    expect(() => assertSecretsReadable(raw, newKey)).not.toThrow()
  })
})
