import type Database from 'better-sqlite3'
import { decrypt, encrypt } from './credentials.js'

/** Columns of the global `groups` table that hold ciphertext under the master key. */
const SECRET_COLUMNS = ['encrypted_app_password', 'encrypted_recovery_key'] as const

export type GroupSecretColumn = (typeof SECRET_COLUMNS)[number]

export interface RekeyKeys {
  /** The key the stored ciphertexts were written with (`ENCRYPTION_KEY`). */
  oldKey: Buffer
  /** The key to re-encrypt them to (`ENCRYPTION_KEY_NEXT`). */
  newKey: Buffer
}

export interface RekeyResult {
  /** Rows in `groups`. */
  groups: number
  /** Ciphertexts re-encrypted from the old key to the new key. */
  rekeyed: number
  /** Ciphertexts that already decrypt under the new key and were left untouched. */
  alreadyCurrent: number
}

/**
 * A stored secret decrypts under neither key. Carries only the DID and the
 * column, never the ciphertext, a plaintext or a key, so it is safe to log and
 * to show in a failed deploy.
 */
export class RekeyError extends Error {
  constructor(
    readonly did: string,
    readonly column: GroupSecretColumn,
  ) {
    super(
      `Cannot decrypt groups.${column} for ${did} with ENCRYPTION_KEY or ENCRYPTION_KEY_NEXT. ` +
        'No rows were changed. Check that ENCRYPTION_KEY is the key the data was written with.',
    )
    this.name = 'RekeyError'
  }
}

/**
 * `ENCRYPTION_KEY` opens none of the stored app passwords. The usual cause is a
 * botched cut-over at the end of a rotation: the rows are under
 * `ENCRYPTION_KEY_NEXT`, but `ENCRYPTION_KEY` still holds the old (or a
 * mistyped) value. Carries only a count, never a key, a plaintext or a
 * ciphertext, so it is safe to log and to show in a failed deploy.
 */
export class EncryptionKeyMismatchError extends Error {
  constructor(readonly groups: number) {
    super(
      `ENCRYPTION_KEY cannot decrypt any of the stored group app passwords (0 of ${groups} readable), so no group could log in to its PDS. ` +
        'If you just finished a key rotation, ENCRYPTION_KEY must hold the value that was ENCRYPTION_KEY_NEXT. ' +
        'Otherwise check that it is the key the data was written with. ' +
        'See docs/deployment.md#rotating-encryption_key.',
    )
    this.name = 'EncryptionKeyMismatchError'
  }
}

interface GroupSecretsRow {
  did: string
  encrypted_app_password: string
  encrypted_recovery_key: string | null
}

/**
 * Re-encrypts every group secret from `oldKey` to `newKey`.
 *
 * All rows commit or none do: a value that decrypts under neither key throws
 * `RekeyError` and rolls the whole pass back. The pass is idempotent. A value
 * that already decrypts under `newKey` is skipped, so a restart, or a deploy
 * that still has `ENCRYPTION_KEY_NEXT` set after the rotation, changes nothing.
 *
 * Takes the raw better-sqlite3 handle rather than Kysely so the pass is one
 * synchronous transaction with no `await` inside, which keeps it atomic with
 * respect to every other handler in this process (see `src/db/sqlite.ts`).
 */
export function rekeyGroupSecrets(raw: Database.Database, keys: RekeyKeys): RekeyResult {
  const selectGroups = raw.prepare<[], GroupSecretsRow>(
    'SELECT did, encrypted_app_password, encrypted_recovery_key FROM groups ORDER BY did',
  )
  const updateColumn: Record<GroupSecretColumn, Database.Statement<[string, string]>> = {
    encrypted_app_password: raw.prepare<[string, string]>(
      'UPDATE groups SET encrypted_app_password = ? WHERE did = ?',
    ),
    encrypted_recovery_key: raw.prepare<[string, string]>(
      'UPDATE groups SET encrypted_recovery_key = ? WHERE did = ?',
    ),
  }

  const rekeyAll = raw.transaction((): RekeyResult => {
    const rows = selectGroups.all()
    const result: RekeyResult = { groups: rows.length, rekeyed: 0, alreadyCurrent: 0 }

    for (const row of rows) {
      for (const column of SECRET_COLUMNS) {
        const stored = row[column]
        if (stored === null) continue // encrypted_recovery_key is NULL for imported groups

        const reencrypted = reencryptValue(stored, keys)
        if (reencrypted === null) throw new RekeyError(row.did, column)

        if (reencrypted.changed) {
          updateColumn[column].run(reencrypted.value, row.did)
          result.rekeyed++
        } else {
          result.alreadyCurrent++
        }
      }
    }
    return result
  })

  // IMMEDIATE takes the write lock before the first read. A deferred
  // transaction reads first and upgrades to a writer at the first UPDATE, which
  // fails at once with SQLITE_BUSY_SNAPSHOT (busy_timeout does not retry it) if
  // another connection committed in between, e.g. a previous deploy still
  // draining, on a platform that overlaps deploys.
  return rekeyAll.immediate()
}

/**
 * Boot check for a start without `ENCRYPTION_KEY_NEXT`: throws
 * `EncryptionKeyMismatchError` if `key` opens none of the stored app passwords.
 *
 * It catches a botched cut-over at the end of a rotation. The rows are already
 * under the new key, but `ENCRYPTION_KEY` still holds the old (or a mistyped)
 * value. Nothing else notices at boot: `/health` only probes the database, so
 * the deploy would be promoted and every group's PDS login would then fail.
 *
 * Only "none readable" fails, so one corrupt legacy row cannot block startup,
 * and an empty table (a fresh install) passes. It looks at app passwords only,
 * because nothing reads `encrypted_recovery_key` at runtime. It stops decrypting
 * at the first readable app password and takes no write lock.
 */
export function assertSecretsReadable(raw: Database.Database, key: Buffer): void {
  const rows = raw
    .prepare<[], { encrypted_app_password: string }>('SELECT encrypted_app_password FROM groups')
    .all()

  if (rows.length === 0) return
  if (rows.some((row) => tryDecrypt(row.encrypted_app_password, key) !== null)) return
  throw new EncryptionKeyMismatchError(rows.length)
}

/**
 * The ciphertext to store for `stored`, or `null` if it decrypts under neither
 * key. A value that already decrypts under the new key is returned unchanged:
 * re-encrypting it would only rewrite the row.
 */
function reencryptValue(
  stored: string,
  { oldKey, newKey }: RekeyKeys,
): { value: string; changed: boolean } | null {
  if (tryDecrypt(stored, newKey) !== null) return { value: stored, changed: false }

  const plaintext = tryDecrypt(stored, oldKey)
  if (plaintext === null) return null
  return { value: encrypt(plaintext, newKey), changed: true }
}

/** `null` means the key does not open the value. A plaintext of `''` is a success. */
function tryDecrypt(ciphertext: string, key: Buffer): string | null {
  try {
    return decrypt(ciphertext, key)
  } catch {
    // GCM authentication fails under the wrong key; a false positive is
    // cryptographically negligible, so "does not decrypt" means "not this key".
    return null
  }
}
