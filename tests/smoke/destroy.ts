/**
 * Smoke test for app.certified.group.destroy against a running CGS (e.g. the
 * PR-30 Railway preview). Removes a group from the service — drops its stored
 * credentials, member index, and per-group DB. The PDS account is left intact.
 *
 * This is a MANUAL smoke test — it hits a live deployment, needs real
 * credentials, and is DESTRUCTIVE, so it is not part of the vitest suite
 * (vitest is configured to exclude tests/smoke/). Run it by hand with tsx.
 *
 * Config comes from the same DEDICATED env file as the import smoke test
 * (tests/smoke/.env — separate from the repo-root .env, gitignored). The group
 * being destroyed is IMPORT_DID (the account imported earlier); OWNER_* is the
 * owner that mints the JWT. Copy tests/smoke/.env.example to tests/smoke/.env.
 *
 * AUTH MODEL — destroy is group-scoped: the JWT's `aud` must be the GROUP DID
 * (not the service DID, unlike import), and the issuer must be the group's owner
 * (RBAC owner role). This script mints that JWT via the owner's password login
 * (a smoke-test convenience — real callers use OAuth/getServiceAuth).
 *
 * SAFETY — because destroy is irreversible at the service level, this script
 * requires you to interactively type the group's handle to confirm. It resolves
 * the handle from IMPORT_DID's DID document and aborts unless your input matches.
 *
 * Run from the worktree (has node_modules):
 *   cd .../.claude/worktrees/adam+hyper-469-group-import
 *   npx tsx tests/smoke/destroy.ts
 *
 * Override the env file path with SMOKE_ENV_FILE=/path/to/file if needed.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import dotenv from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
const envFile = process.env.SMOKE_ENV_FILE || join(here, '.env')
const loaded = dotenv.config({ path: envFile })
if (loaded.error) {
  console.error(`Could not read smoke-test env file: ${envFile}`)
  console.error(`Copy ${join(here, '.env.example')} to ${envFile} and fill it in.`)
  process.exit(2)
}
console.log(`Loaded smoke-test config from ${envFile}`)

import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'

const DESTROY_NSID = 'app.certified.group.destroy'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

async function confirmByHandle(handle: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(
      `\n⚠️  This will DESTROY the group in the CGS (the PDS account is left intact).\n` +
        `   To confirm, type the group's handle exactly: ${handle}\n> `,
    )
    if (answer.trim() !== handle) {
      console.error('\n❌ Handle did not match — aborting, nothing destroyed.')
      process.exit(1)
    }
  } finally {
    rl.close()
  }
}

async function main() {
  const cgsUrl = reqEnv('CGS_URL').replace(/\/$/, '')
  const ownerPds = reqEnv('OWNER_PDS')
  const ownerIdentifier = reqEnv('OWNER_IDENTIFIER')
  const ownerPassword = reqEnv('OWNER_PASSWORD')
  const groupDid = reqEnv('IMPORT_DID')

  console.log('CGS URL:   ', cgsUrl)
  console.log('Owner PDS: ', ownerPds)
  console.log('Owner:     ', ownerIdentifier)
  console.log('Group DID: ', groupDid)
  console.log('---')

  // Resolve the group's handle from its DID document for the confirmation
  // prompt. We use the real identity resolver so the handle shown is the one
  // actually published, not something the operator typed.
  console.log('Resolving group handle from DID document...')
  const idResolver = new IdResolver()
  const atprotoData = await idResolver.did.resolveAtprotoData(groupDid)
  const handle = atprotoData.handle
  console.log('Group handle:', handle)

  await confirmByHandle(handle)

  // Log into the owner's PDS and mint a service-auth JWT for destroy. NOTE the
  // audience is the GROUP DID (group-scoped method), not the service DID.
  console.log('\nLogging into owner PDS to mint service-auth JWT...')
  const ownerAgent = new AtpAgent({ service: ownerPds })
  await ownerAgent.login({ identifier: ownerIdentifier, password: ownerPassword })
  console.log('Owner DID resolved:', ownerAgent.session?.did)

  const {
    data: { token },
  } = await ownerAgent.com.atproto.server.getServiceAuth({
    aud: groupDid,
    lxm: DESTROY_NSID,
  })
  console.log('Minted service-auth JWT (aud =', groupDid + ', lxm =', DESTROY_NSID + ')')

  // destroy takes no request body — groupDid comes from the JWT audience.
  console.log('---\nPOST', `${cgsUrl}/xrpc/${DESTROY_NSID}`)
  const res = await fetch(`${cgsUrl}/xrpc/${DESTROY_NSID}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }

  console.log('---')
  console.log('HTTP', res.status)
  console.log('response:', parsed)

  if (res.ok) {
    console.log('\n✅ destroy succeeded')
    process.exit(0)
  } else {
    console.log('\n❌ destroy failed')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n❌ smoke test errored:', err)
  process.exit(1)
})
