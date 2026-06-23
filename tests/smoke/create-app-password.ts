/**
 * Helper for the import smoke test: mint an app password for the IMPORTER
 * account (the one being promoted to a group), so you can paste it into
 * IMPORTER_APP_PASSWORD in tests/smoke/.env.
 *
 * Creating an app password requires a FULL session (com.atproto.server
 * .createAppPassword needs the ACCESS_FULL scope), i.e. the account's real
 * password — an app password cannot mint another. This script logs in with
 * IMPORTER_PASSWORD and mints on that same account, so no cross-account check
 * is needed.
 *
 * Config comes from the same dedicated env file as the import smoke test
 * (tests/smoke/.env — separate from the repo-root .env, gitignored). It reads
 * only var names declared in .env.example; it never depends on inspecting the
 * filled-in secrets.
 *
 * Run from the worktree (has node_modules):
 *   cd .../.claude/worktrees/adam+hyper-469-group-import
 *   npx tsx tests/smoke/create-app-password.ts
 *
 * Then copy the printed password into IMPORTER_APP_PASSWORD in tests/smoke/.env.
 *
 * Override the env file path with SMOKE_ENV_FILE=/path/to/file if needed.
 */
import { loadSmokeEnv, reqEnv, resolveAccount } from './lib.js'

// Load ONLY the dedicated smoke-test env file (never the repo-root .env).
loadSmokeEnv(import.meta.url)

import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'

// Fixed label so the password is identifiable in the account's settings. The
// PDS rejects a duplicate name, so if you re-run after a failure either revoke
// the old one or pass APP_PASSWORD_NAME to override.
const APP_PASSWORD_NAME = process.env.APP_PASSWORD_NAME || 'cgs-import-smoke'

async function main() {
  const importerIdentifier = reqEnv('IMPORTER_IDENTIFIER')
  const importerPassword = reqEnv('IMPORTER_PASSWORD')

  console.log('Importer:', importerIdentifier)
  console.log('---')

  // Derive the importer's PDS from its DID document (IMPORTER_IDENTIFIER may be
  // a handle), then log in there with full credentials.
  const importer = await resolveAccount(new IdResolver(), importerIdentifier)
  console.log('Importer PDS:', importer.pds)

  console.log('Logging into importer PDS with full credentials...')
  const agent = new AtpAgent({ service: importer.pds })
  await agent.login({ identifier: importerIdentifier, password: importerPassword })
  console.log('Logged in as:', agent.session?.did)

  console.log(`Creating app password "${APP_PASSWORD_NAME}"...`)
  const { data } = await agent.com.atproto.server.createAppPassword({
    name: APP_PASSWORD_NAME,
  })

  console.log('\n✅ App password created. Copy this into IMPORTER_APP_PASSWORD:\n')
  console.log('   ' + data.password)
  console.log('\n(Shown once; the PDS will not display it again.)')
}

main().catch((err) => {
  console.error('\n❌ failed to create app password:', err)
  process.exit(1)
})
