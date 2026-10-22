import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestContext } from './helpers/mock-server.js'
import { finalizeGroup } from '../src/api/group/finalize.js'
import { decrypt } from '../src/pds/credentials.js'
import type { Config } from '../src/config.js'

const GROUP_DID = 'did:plc:newgroup'
const APP_PASSWORD = 'app-pass-xxxx'
const RECOVERY_KEY_MATERIAL = 'recovery-key-material'

describe('finalizeGroup credential encryption', () => {
  let test: Awaited<ReturnType<typeof createTestContext>>

  beforeEach(async () => {
    test = await createTestContext()
  })

  afterEach(async () => {
    await test.globalDb.destroy()
    await test.groupDb.destroy()
  })

  async function finalizeWithConfig(configOverrides: Partial<Config>) {
    const config = { ...test.ctx.config, ...configOverrides }

    await finalizeGroup(
      { ...test.ctx, config },
      {
        groupDid: GROUP_DID,
        pdsUrl: 'https://pds.example.com',
        appPassword: APP_PASSWORD,
        ownerDid: 'did:plc:owner',
        recoveryKeyMaterial: RECOVERY_KEY_MATERIAL,
        action: 'group.register',
        handle: 'mygroup.pds.example.com',
      },
    )

    const row = await test.globalDb
      .selectFrom('groups')
      .selectAll()
      .where('did', '=', GROUP_DID)
      .executeTakeFirstOrThrow()
    return { config, row }
  }

  it('encrypts under ENCRYPTION_KEY when no rotation is in progress', async () => {
    const { config, row } = await finalizeWithConfig({ encryptionKeyNext: undefined })
    const currentKey = Buffer.from(config.encryptionKey, 'hex')

    expect(decrypt(row.encrypted_app_password, currentKey)).toBe(APP_PASSWORD)
    expect(decrypt(row.encrypted_recovery_key!, currentKey)).toBe(RECOVERY_KEY_MATERIAL)
  })

  it('encrypts under ENCRYPTION_KEY_NEXT during a rotation, so the new group needs no re-keying', async () => {
    const encryptionKeyNext = 'b'.repeat(64)
    const { config, row } = await finalizeWithConfig({ encryptionKeyNext })
    const nextKey = Buffer.from(encryptionKeyNext, 'hex')
    const currentKey = Buffer.from(config.encryptionKey, 'hex')

    expect(decrypt(row.encrypted_app_password, nextKey)).toBe(APP_PASSWORD)
    expect(decrypt(row.encrypted_recovery_key!, nextKey)).toBe(RECOVERY_KEY_MATERIAL)
    expect(() => decrypt(row.encrypted_app_password, currentKey)).toThrow()
    expect(() => decrypt(row.encrypted_recovery_key!, currentKey)).toThrow()
  })
})
