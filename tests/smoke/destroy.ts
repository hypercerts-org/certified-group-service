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
 * being destroyed is IMPORTER_IDENTIFIER (the account imported earlier);
 * GROUP_OWNER_* is the owner that mints the JWT. Copy tests/smoke/.env.example
 * to tests/smoke/.env.
 *
 * AUTH MODEL — destroy is group-scoped: the JWT's `aud` must be the GROUP DID
 * (not the service DID, unlike import), and the issuer must be the group's owner
 * (RBAC owner role) — i.e. GROUP_OWNER_*. This script mints that JWT via the
 * owner's password login (a smoke-test convenience — real callers use
 * OAuth/getServiceAuth).
 *
 * SAFETY — because destroy is irreversible at the service level, this script
 * requires you to interactively type the group's handle to confirm. It resolves
 * the handle from the group DID's DID document and aborts unless your input
 * matches.
 *
 * Run from the worktree (has node_modules):
 *   cd .../.claude/worktrees/adam+hyper-469-group-import
 *   npx tsx tests/smoke/destroy.ts
 *
 * Override the env file path with SMOKE_ENV_FILE=/path/to/file if needed.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { loadSmokeEnv, reqEnv, resolveAccount } from './lib.js'

// Load ONLY the dedicated smoke-test env file (never the repo-root .env).
loadSmokeEnv(import.meta.url)

import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'

const DESTROY_NSID = 'app.certified.group.destroy'

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
  const groupOwnerIdentifier = reqEnv('GROUP_OWNER_IDENTIFIER')
  const groupOwnerPassword = reqEnv('GROUP_OWNER_PASSWORD')
  const groupIdentifier = reqEnv('IMPORTER_IDENTIFIER')

  console.log('CGS URL:     ', cgsUrl)
  console.log('Group owner: ', groupOwnerIdentifier)
  console.log('Group:       ', groupIdentifier)
  console.log('---')

  // Resolve the group (the imported account) — its DID is the JWT aud, and its
  // published handle is shown in the confirmation prompt. IMPORTER_IDENTIFIER
  // may be a handle; resolveAccount handles both.
  const idResolver = new IdResolver()
  console.log('Resolving group from DID document...')
  const group = await resolveAccount(idResolver, groupIdentifier)
  const groupDid = group.did
  const handle = group.handle
  console.log('Group DID:   ', groupDid)
  console.log('Group handle:', handle)

  await confirmByHandle(handle)

  // Log into the GROUP OWNER's PDS and mint a service-auth JWT for destroy.
  // destroy is owner-gated, so the JWT issuer must be the group's RBAC owner.
  // NOTE the audience is the GROUP DID (group-scoped method), not the service DID.
  //
  // NOTE (#27): aud-as-group-selector is the legacy form and will be deprecated.
  // Once #27 lands, aud must be the service DID and the group is read from the
  // request — but destroy currently has NO group field in its body (the group
  // comes purely from aud), so the #27 fix needs to add an explicit group field
  // to the destroy lexicon, then this script sets aud = service DID and passes
  // the group in the request. See docs/design/api-keys.md.
  const owner = await resolveAccount(idResolver, groupOwnerIdentifier)
  console.log('\nLogging into group owner PDS to mint service-auth JWT...')
  const ownerAgent = new AtpAgent({ service: owner.pds })
  await ownerAgent.login({ identifier: groupOwnerIdentifier, password: groupOwnerPassword })
  console.log('Group owner DID resolved:', ownerAgent.session?.did)

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
