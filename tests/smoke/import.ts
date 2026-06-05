/**
 * Smoke test for app.certified.group.import against a running CGS (e.g. the
 * PR-30 Railway preview). Exercises the full functional path: mint a real
 * service-auth JWT, POST to import, report the result.
 *
 * This is a MANUAL smoke test — it hits a live deployment and needs real
 * credentials, so it is not part of the vitest suite (vitest is configured to
 * exclude tests/smoke/). Run it by hand with tsx.
 *
 * Config comes from a DEDICATED env file, tests/smoke/.env — separate from the
 * repo-root .env (which holds real service config). The two are never mixed:
 * this script loads only the file next to it, and .env is gitignored so the
 * secrets in it can't be committed. Copy tests/smoke/.env.example to
 * tests/smoke/.env and fill it in.
 *
 * Run from the worktree (has node_modules):
 *   cd .../.claude/worktrees/adam+hyper-469-group-import
 *   npx tsx tests/smoke/import.ts
 *
 * Override the env file path with SMOKE_ENV_FILE=/path/to/file if needed.
 *
 * AUTH CAVEAT — this script mints the service-auth JWT via a password login
 * (com.atproto.server.createSession). That is a SMOKE-TEST CONVENIENCE, not the
 * production pattern. Real callers (see demo/server, docs/integration-guide.md)
 * authenticate via OAuth and call getServiceAuth over an OAuth session — no
 * account password involved. ePDS accounts are OTP/OAuth-first and may have no
 * password by default; set one on the throwaway test owner account to use this
 * script, or rework it to use @atproto/oauth-client-node to mirror production.
 *
 * Notes:
 * - OWNER_* is the account that will become the group owner. It must be able to
 *   mint a service-auth JWT (getServiceAuth) proving control of its DID. Here we
 *   obtain that via password login, so OWNER_PASSWORD must be a real account
 *   password (set one if the account is OTP-only).
 * - IMPORT_DID / IMPORT_APP_PASSWORD identify the account being imported. In the
 *   common case where the owner IS the account being imported, set OWNER_IDENTIFIER
 *   to that same DID and reuse the app password.
 * - aud MUST equal the CGS's configured serviceDid. If the preview derives it
 *   from SERVICE_URL, the default below is correct; otherwise set CGS_SERVICE_DID.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'

// Load ONLY the dedicated smoke-test env file (tests/smoke/.env, sitting next
// to this script). Never the repo-root .env.
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

const IMPORT_NSID = 'app.certified.group.import'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

async function main() {
  const cgsUrl = reqEnv('CGS_URL').replace(/\/$/, '')
  const ownerPds = reqEnv('OWNER_PDS')
  const ownerIdentifier = reqEnv('OWNER_IDENTIFIER')
  const ownerPassword = reqEnv('OWNER_PASSWORD')
  const importDid = reqEnv('IMPORT_DID')
  const importAppPassword = reqEnv('IMPORT_APP_PASSWORD')
  const serviceDid =
    process.env.CGS_SERVICE_DID || `did:web:${new URL(cgsUrl).hostname}`

  console.log('CGS URL:        ', cgsUrl)
  console.log('CGS service DID:', serviceDid)
  console.log('Owner PDS:      ', ownerPds)
  console.log('Owner:          ', ownerIdentifier)
  console.log('Import DID:     ', importDid)
  console.log('---')

  // 1) Log into the owner's PDS and mint a service-auth JWT for import.
  console.log('Logging into owner PDS to mint service-auth JWT...')
  const ownerAgent = new AtpAgent({ service: ownerPds })
  await ownerAgent.login({ identifier: ownerIdentifier, password: ownerPassword })
  const ownerDid = ownerAgent.session?.did
  if (!ownerDid) throw new Error('Owner login did not yield a DID')
  console.log('Owner DID resolved:', ownerDid)

  const {
    data: { token },
  } = await ownerAgent.com.atproto.server.getServiceAuth({
    aud: serviceDid,
    lxm: IMPORT_NSID,
  })
  console.log('Minted service-auth JWT (aud =', serviceDid + ', lxm =', IMPORT_NSID + ')')

  // 2) Call import on the CGS.
  const body = { groupDid: importDid, appPassword: importAppPassword, ownerDid }
  console.log('---\nPOST', `${cgsUrl}/xrpc/${IMPORT_NSID}`)
  console.log('body:', { ...body, appPassword: '***redacted***' })

  const res = await fetch(`${cgsUrl}/xrpc/${IMPORT_NSID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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
    console.log('\n✅ import succeeded')
    process.exit(0)
  } else {
    console.log('\n❌ import failed')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n❌ smoke test errored:', err)
  process.exit(1)
})
