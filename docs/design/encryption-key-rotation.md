# Design: `ENCRYPTION_KEY` rotation

Status: **accepted**. Tracking: [TECH-777](https://linear.app/hypercerts/issue/TECH-777).
Trigger: Railway incident [QH8L8B3E](https://status.railway.com/incident/QH8L8B3E),
which may have exposed service environment variables. The volume was **not**
exposed, so this is hygiene: rotating the key is sufficient. The current key is a
sealed Railway variable and cannot be read by anyone, so rotation must not
require knowing it.

## Problem

`ENCRYPTION_KEY` is a single AES-256-GCM master key (`src/pds/credentials.ts`).
It encrypts the two per-group secrets the service stores:

| Column (global DB `groups`) | Written by              | Read by                                                    |
| --------------------------- | ----------------------- | ---------------------------------------------------------- |
| `encrypted_app_password`    | `api/group/finalize.ts` | `PdsAgentPool._login` (every PDS write after login/expiry) |
| `encrypted_recovery_key`    | `api/group/finalize.ts` | nothing at runtime (break-glass material); nullable        |

The per-group DBs contain no ciphertext. API keys (`cgsk_…`) are stored
separately and are not encrypted with this key.

The service accepts exactly one key. If you swap `ENCRYPTION_KEY`, every
`decrypt()` throws (GCM auth tag mismatch), and every group loses PDS write
access the next time its agent logs in. The repo has no rotation path today.

## Threat model and what rotation does and does not fix

| Exposure                | Attacker can                                  | Fix                                                                                      |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Env vars only           | Nothing yet. Key without ciphertext is inert. | **Rotate key** (this design)                                                             |
| Volume / DB backup only | Nothing. Ciphertext without key is inert.     | Rotate key (defence in depth)                                                            |
| Env vars **and** volume | Decrypt every app password and recovery key.  | **Re-issue credentials** (out of scope, see below). Rotating the key alone does nothing. |

Before choosing the response, confirm from the incident report which of these
cases applies.

## Approaches considered

1. **Re-key at boot with `ENCRYPTION_KEY_NEXT` (chosen).** The operator leaves
   `ENCRYPTION_KEY` (current, possibly sealed) untouched and adds
   `ENCRYPTION_KEY_NEXT` (new). On startup, before the server listens, the
   service re-encrypts every row from current to next in one transaction and
   uses the next key from then on. The operator then sets `ENCRYPTION_KEY` to
   the new value and removes `_NEXT`.
   - Nobody ever needs to read the current key, which matters because it is
     sealed. A `_PREVIOUS` variant (copy the old key into a new variable) was
     rejected for exactly that reason.
   - No shell or volume access is needed, which suits Railway, where the volume
     is only mounted on the running service.
   - The request path stays single-key (the active key).
2. **Standalone offline CLI (`scripts/rekey.ts`).** Stop the service, run the
   script against the volume, then start the service. This is cleaner where the
   operator has a shell, but on Railway it needs a stopped service that still
   has its volume mounted. Rejected as the primary path. The core function is
   reusable if we want a CLI later.
3. **Dual-key decrypt with lazy re-encrypt on read.** No restart window, but a
   fallback key stays live on the hot request path indefinitely, rows are only
   migrated when touched, and the recovery-key rows are never read. Rejected.

## Design

### Config

```ts
// src/config.ts
encryptionKey: hexKey64,                  // ENCRYPTION_KEY (current)
encryptionKeyNext: hexKey64.optional(),   // ENCRYPTION_KEY_NEXT (rotation target)
// refine (case-insensitive compare): encryptionKeyNext !== encryptionKey
//   message: 'ENCRYPTION_KEY_NEXT must differ from ENCRYPTION_KEY. If rotation is
//   complete, remove ENCRYPTION_KEY_NEXT.'
```

The key used at runtime for both encrypt and decrypt is
`encryptionKeyNext ?? encryptionKey`. Resolve it once (e.g. a small
`activeEncryptionKey(config): Buffer` helper next to the config) and use it in
`PdsAgentPool` construction (`index.ts`) and `finalizeGroup`
(`api/group/finalize.ts`). Do not scatter the `??` across call sites.

### Core function (pure, sync, unit-testable)

```ts
// src/pds/rekey.ts
export interface RekeyResult {
  groups: number
  rekeyed: number      // ciphertexts re-encrypted old -> new
  alreadyCurrent: number // ciphertexts that already decrypt under the new key
}

export class RekeyError extends Error {
  // e.g. "Cannot decrypt groups.encrypted_app_password for did:plc:abc with
  //  ENCRYPTION_KEY or ENCRYPTION_KEY_NEXT. No rows were changed. Check that
  //  ENCRYPTION_KEY is the key the data was written with."
  constructor(readonly did: string, readonly column: Column) { ... }
}

/**
 * Re-encrypts all group secrets from `oldKey` to `newKey`.
 * One better-sqlite3 transaction: all rows commit or none do.
 * Idempotent: values that already decrypt under `newKey` are skipped,
 * so a restart or a deploy that still has ENCRYPTION_KEY_NEXT set after cut-over is harmless.
 */
export function rekeyGroupSecrets(
  raw: Database.Database,
  keys: { newKey: Buffer; oldKey: Buffer },
): RekeyResult

// internal helper
function reencryptValue(value, keys): { value: string; changed: boolean }
  // try decrypt(newKey) -> { value, changed: false }
  // else try decrypt(oldKey) -> { value: encrypt(plain, newKey), changed: true }
  // else throw RekeyError
```

Notes:

- It uses `raw` (better-sqlite3) rather than Kysely, so the whole pass is one
  synchronous transaction with no `await` inside, the same pattern the codebase
  already relies on (see `src/db/sqlite.ts`).
- `decrypt` stays unchanged. A "does it decrypt" check is a try/catch around
  it. GCM authentication makes a false positive under the wrong key
  cryptographically negligible.
- Null `encrypted_recovery_key` is skipped.
- Plaintext is never logged. Errors carry only the DID and the column name.

### Boot wiring

```ts
// src/index.ts — after runGlobalMigrations, before PdsAgentPool / listen
const { db: globalDb, raw: globalRaw } = openSqliteDb(...)
await runGlobalMigrations(globalDb)

if (config.encryptionKeyNext) {
  const result = rekeyGroupSecrets(globalRaw, {
    oldKey: Buffer.from(config.encryptionKey, 'hex'),
    newKey: Buffer.from(config.encryptionKeyNext, 'hex'),
  })
  logger.warn(result,
    'Encryption key rotation complete. Set ENCRYPTION_KEY to the ENCRYPTION_KEY_NEXT value, remove ENCRYPTION_KEY_NEXT, and redeploy.')
} else {
  // Normal boot: fail startup if ENCRYPTION_KEY opens none of the stored app passwords.
  assertSecretsReadable(globalRaw, activeEncryptionKey(config))
}
// RekeyError / EncryptionKeyMismatchError propagate -> main() rejects -> process
// exits non-zero, with the stored credentials untouched. Railway marks the
// deploy failed. Whether the previous deploy keeps serving in the meantime
// depends on how Railway rolls over a service with a volume (open question 1).
// If it overlaps the two deploys it does. If it stops the old one first, a
// failed boot is downtime until the variables are fixed.
```

Ownership: `index.ts` owns the decision to rotate or to check, `rekey.ts` owns
the transaction, rollback and readability check, and `credentials.ts` keeps
owning the crypto.

### Boot readability check

Added after review. With `ENCRYPTION_KEY_NEXT` unset, nothing at boot would
notice a botched cut-over: step 5 leaves `ENCRYPTION_KEY` at the old (or a
mistyped) value after every row was re-keyed. `/health` only probes the
database, so the deploy is promoted, and each group's first PDS login then fails
with a GCM auth error. A `group.register` or `group.import` in that window
would also write a row under the wrong key.

```ts
// src/pds/rekey.ts
export class EncryptionKeyMismatchError extends Error {
  constructor(readonly groups: number) { ... }
}

/** Throws EncryptionKeyMismatchError if `key` opens none of the stored app passwords. */
export function assertSecretsReadable(raw: Database.Database, key: Buffer): void
```

- It runs only on a non-rotation boot, as the `else` of
  `if (config.encryptionKeyNext)`, with `activeEncryptionKey(config)`. A
  successful re-key already proves every stored value is readable.
- It fails only if `groups` is non-empty **and** no `encrypted_app_password`
  decrypts. One corrupt legacy row never blocks startup, and a fresh install
  (empty table) passes.
- It looks at app passwords only: nothing reads `encrypted_recovery_key` at
  runtime.
- It stops decrypting at the first readable row, is read-only, and takes no
  write lock.
- The message says what went wrong and what to do (`ENCRYPTION_KEY` must hold
  the value that was `ENCRYPTION_KEY_NEXT`) and links the runbook. It carries a
  count, never a key, a plaintext or a ciphertext.
- Limit: one readable row is enough, so a stray row written under the old key
  (see the overlap note in the runbook) can mask a wrong `ENCRYPTION_KEY`. The
  smoke test in step 5 stays.

### Keep / drop

- **Keep:** single-key `PdsAgentPool` and `finalize`; the `credentials.ts`
  format (iv + tag + ciphertext, base64).
- **Add:** the boot readability check (`assertSecretsReadable`) on every
  non-rotation boot. It is the only guard against a botched cut-over, and it
  needs no runtime fallback decrypt.
- **Drop:** any runtime fallback decrypt, key IDs or versioning in the
  ciphertext format (not needed for a rare, operator-driven rotation; revisit
  if rotation becomes routine).

## Operator runbook (to go in `docs/deployment.md`)

The authoritative runbook is in
[`docs/deployment.md`](../deployment.md#rotating-encryption_key). This copy is
the design-time sketch and can lag it.

1. **Back up** the volume with the platform's volume backup. If a file copy is
   needed, use SQLite's backup API from a shell in the running container,
   writing `global.sqlite.bak`: the runtime image has no `sqlite3` CLI, and
   copying `global.sqlite`, `-wal` and `-shm` one by one while the service runs
   can give an inconsistent copy.
2. Generate a key:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Add `ENCRYPTION_KEY_NEXT=<new key>` (sealed). Leave `ENCRYPTION_KEY`
   untouched. Redeploy.
4. Check the boot log for `Encryption key rotation complete` with
   `rekeyed` = expected count. Smoke test one group write (e.g. `putRecord`).
5. Overwrite `ENCRYPTION_KEY` with the new key (sealed), remove
   `ENCRYPTION_KEY_NEXT`, and redeploy. This boot does no re-keying. It only
   checks that `ENCRYPTION_KEY` opens at least one stored app password.
6. Delete backups taken before step 3, including `global.sqlite.bak`; they are
   encrypted under the retired key.

Do not roll back to a deploy from before step 3 once the re-key has committed
(the `Encryption key rotation complete` log line): that build only knows the old
key and cannot decrypt the re-keyed rows.

On a `RekeyError` (or a config error) the deploy fails with the DID and column
named and the stored credentials untouched, so the fix is to correct the env
vars and retry, or to remove `ENCRYPTION_KEY_NEXT` to go back. Whether the
previous deploy keeps serving in the meantime depends on how Railway rolls over
a service with a volume (open question 1). If it overlaps the two deploys it
does. Otherwise a failed rotation boot is downtime until the variables are
fixed.

The re-key commits before the rest of boot (per-group migrations, the
member-index backfill, `listen`). If a deploy fails after the
`Encryption key rotation complete` line was logged, the data is already under
the new key: keep `ENCRYPTION_KEY_NEXT` set, fix the cause and redeploy.
Removing it would leave `ENCRYPTION_KEY` unable to read the rows.

Note: if Railway overlaps the old and new deploy on a volume service, the old
deploy still holds only the old key after the commit. A fresh login on it fails
until it is replaced. It can also _write_ under the old key: `finalizeGroup`
(`group.register`, `group.import`) encrypts a new row with whatever key its
process holds, and that row is unreadable once `ENCRYPTION_KEY` holds the new
key. The fix is one more redeploy with `ENCRYPTION_KEY_NEXT` still set before
step 5: the re-key is idempotent and picks those rows up (`rekeyed` above 0).
Schedule the rotation during low traffic. If Railway stops the old deploy before
starting the new one, there is no overlap and none of this applies (open
question 1).

## Testing

`tests/rekey.test.ts` (in-memory SQLite plus global migrations):

- Mixed rows (some old-key, some already new-key) are all readable under the
  new key afterwards, and the counts are correct.
- A null `encrypted_recovery_key` is left null.
- A row encrypted with a third, unknown key throws `RekeyError` with the DID
  and column, and **no** row changes (rollback).
- Running twice is a no-op the second time (`rekeyed: 0`).
- An empty `groups` table gives zero counts.
- An empty-string plaintext is a valid secret: re-encrypted under the old key,
  counted as current under the new key.
- `assertSecretsReadable` throws `EncryptionKeyMismatchError` when no app
  password decrypts (a readable recovery key does not count), and does not throw
  when at least one is readable among unreadable ones, or for an empty table.

`tests/config.test.ts`:

- `ENCRYPTION_KEY_NEXT` is optional, must be 64 hex characters, and must
  differ from `ENCRYPTION_KEY` (including case-only differences).

Active-key selection: a test that `finalizeGroup` encrypts with `_NEXT` when it
is set (decryptable with next, not with current).

The boot wiring in `index.ts` is excluded from coverage. Keep it to the
few lines above so all the logic stays in `rekey.ts`.

## Docs and release

- `docs/deployment.md`: a "Rotating `ENCRYPTION_KEY`" section with the runbook.
- `README.md`: an `ENCRYPTION_KEY_NEXT` row in the env var table.
- `.env.example`: a commented `ENCRYPTION_KEY_NEXT=`.
- Changeset (minor): a new optional env var, an operator procedure, and the
  startup readability check.

## Out of scope: if the volume was also exposed

Rotating the key does not protect secrets the attacker has already
decrypted. For each group:

1. Revoke the app password on the group's PDS and create a new one, then write
   it encrypted under the new key. This needs a new admin operation or script
   (e.g. `app.certified.group.admin.rotateAppPassword`), so it gets its own
   design.
2. If a recovery key was stored, submit a PLC operation that removes it from
   `rotationKeys`, and generate and store a replacement.

## Open questions

1. Railway rollover: is there any overlap between the old and new deploy on a
   service with a volume? (Affects the failure and overlap notes in the
   runbook.)
2. Should `encrypted_recovery_key` decryption be verified in the smoke test?
   Nothing reads it at runtime, so a corrupt value would go unnoticed.
   Partly answered by the implementation: the rotation boot decrypts every
   non-null `encrypted_recovery_key` (it has to, to re-key it), so a corrupt one
   fails the rotation with a `RekeyError` instead of going unnoticed. The boot
   readability check looks at app passwords only, so outside a rotation a
   corrupt recovery key is still not detected.
