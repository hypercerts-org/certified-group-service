import type { AppContext } from '../../context.js'
import { ConflictError } from '../../errors.js'
import { encrypt } from '../../pds/credentials.js'

export interface FinalizeGroupParams {
  /** DID of the group account (created by register, or pre-existing for import). */
  groupDid: string
  /** PDS hosting the group account; stored verbatim and reused by PdsAgentPool. */
  pdsUrl: string
  /** App password the service uses to act on the account's behalf (plaintext). */
  appPassword: string
  /** DID seeded as the immutable owner. */
  ownerDid: string
  /**
   * Recovery-key material to store, already base64url-encoded, or `null` when
   * the service holds no recovery key for this group (the import case). The
   * `groups.encrypted_recovery_key` column is nullable.
   */
  recoveryKeyMaterial: string | null
  /** Audit action: distinguishes how the group entered the service. */
  action: 'group.register' | 'group.import'
  /** Resolved full handle, recorded in the audit detail. */
  handle: string
}

/**
 * Shared tail of `group.register` and `group.import`: persist the group's
 * credentials, initialise its per-group database, seed the owner, and audit-log
 * the operation. Everything before this differs between the two (register
 * creates an account and signs a PLC op; import logs in to an existing one),
 * but from credential storage onward the two are identical save for the
 * recovery key and the audit action.
 *
 * Throws `ConflictError('GroupAlreadyRegistered')` if the group DID is already
 * present in the `groups` table.
 */
export async function finalizeGroup(ctx: AppContext, params: FinalizeGroupParams): Promise<void> {
  const { groupDid, pdsUrl, appPassword, ownerDid, recoveryKeyMaterial, action, handle } = params

  const encryptionKey = Buffer.from(ctx.config.encryptionKey, 'hex')
  const encryptedAppPassword = encrypt(appPassword, encryptionKey)
  const encryptedRecoveryKey =
    recoveryKeyMaterial === null ? null : encrypt(recoveryKeyMaterial, encryptionKey)

  try {
    await ctx.globalDb
      .insertInto('groups')
      .values({
        did: groupDid,
        pds_url: pdsUrl,
        encrypted_app_password: encryptedAppPassword,
        encrypted_recovery_key: encryptedRecoveryKey,
      })
      .execute()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY constraint failed')) {
      throw new ConflictError('Group already registered', 'GroupAlreadyRegistered')
    }
    throw err
  }

  // Initialize per-group database and run migrations
  await ctx.groupDbs.migrateGroup(groupDid)

  // Seed owner (atomic write to both group DB and member_index)
  const groupDb = ctx.groupDbs.get(groupDid)
  const groupRaw = ctx.groupDbs.getRaw(groupDid)
  ctx.memberIndex.add(groupRaw, groupDid, ownerDid, 'owner', ownerDid)

  // Audit log the group creation/import
  await ctx.audit.log(groupDb, ownerDid, action, 'permitted', { handle })
}
