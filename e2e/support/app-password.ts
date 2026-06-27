/**
 * Mints an app password on the importer account, producing the value for
 * E2E_GROUP_IMPORTER_APP_PASSWORD in e2e/.env. This is NOT a CGS feature under test — it
 * is a PDS-side operation (com.atproto.server.createAppPassword) that yields a
 * config value, so it lives in support/ as a helper rather than a scenario.
 *
 * Run it directly:  pnpm e2e:app-password
 * Then copy the printed password into E2E_GROUP_IMPORTER_APP_PASSWORD.
 *
 * Creating an app password requires a FULL session (the account's real
 * password), so E2E_GROUP_IMPORTER_PASSWORD must be set.
 */
import { AtpAgent } from '@atproto/api'
import { idResolver, resolveAccount } from './cgs.js'
import { testEnv } from './env.js'

export async function mintAppPassword(opts: {
  identifier: string
  password: string
  name: string
}): Promise<string> {
  const account = await resolveAccount(idResolver, opts.identifier)
  const agent = new AtpAgent({ service: account.pds })
  await agent.login({ identifier: opts.identifier, password: opts.password })
  const { data } = await agent.com.atproto.server.createAppPassword({ name: opts.name })
  return data.password
}

async function main(): Promise<void> {
  if (!testEnv.importerPassword) {
    console.error(
      'E2E_GROUP_IMPORTER_PASSWORD is not set in e2e/.env — required to mint an app password.',
    )
    process.exit(2)
  }
  console.log('Importer:', testEnv.importerIdentifier)
  console.log(`Minting app password "${testEnv.appPasswordName}"...`)
  const password = await mintAppPassword({
    identifier: testEnv.importerIdentifier,
    password: testEnv.importerPassword,
    name: testEnv.appPasswordName,
  })
  console.log('\n✅ App password created. Copy this into E2E_GROUP_IMPORTER_APP_PASSWORD:\n')
  console.log('   ' + password)
  console.log('\n(Shown once; the PDS will not display it again.)')
}

// Run main() only when invoked directly (not when imported by a step file).
const invokedDirectly = process.argv[1]?.endsWith('app-password.ts')
if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n❌ failed to create app password:', err)
    process.exit(1)
  })
}
