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
 * AUTH MODEL — import is option a: the JWT must be signed by the account being
 * imported (iss === groupDid), NOT by the prospective owner. So this script logs
 * in as the IMPORTER account and mints the JWT from that session. The ownerDid in
 * the request body is GROUP_OWNER_IDENTIFIER (the grantee); it is named but not
 * separately authenticated, so the script does not log in as the owner.
 *
 * AUTH CAVEAT — minting the JWT via a password login
 * (com.atproto.server.createSession) is a SMOKE-TEST CONVENIENCE, not the
 * production pattern. Real callers (see docs/integration-guide.md) authenticate
 * via OAuth and call getServiceAuth over an OAuth session — no account password
 * involved. ePDS accounts are OTP/OAuth-first and may have no password by default;
 * set one on the throwaway test importer account to use this script, or rework it
 * to use @atproto/oauth-client-node to mirror production.
 *
 * Notes:
 * - IMPORTER_* is the account being promoted to a group (groupDid). It signs the
 *   import JWT, so it must be able to mint a service-auth JWT proving control of
 *   its DID; here that is a password login, so IMPORTER_PASSWORD must be real.
 *   IMPORTER_APP_PASSWORD is the app password the service stores to act on it.
 * - GROUP_OWNER_IDENTIFIER (handle or DID) identifies the account seeded as the
 *   group's owner (ownerDid); a handle is resolved to a DID for the request body.
 *   Common case: it is the importer's own account. It may differ; it is not
 *   authenticated (no login as the owner).
 * - aud MUST equal the CGS's configured serviceDid. If the preview derives it
 *   from SERVICE_URL, the default below is correct; otherwise set CGS_SERVICE_DID.
 */
import { loadSmokeEnv, reqEnv, resolveToDid, resolveAccount } from './lib.js'

// Load ONLY the dedicated smoke-test env file (never the repo-root .env).
loadSmokeEnv(import.meta.url)

import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'

const IMPORT_NSID = 'app.certified.group.import'

async function main() {
  const cgsUrl = reqEnv('CGS_URL').replace(/\/$/, '')
  const importerIdentifier = reqEnv('IMPORTER_IDENTIFIER')
  const importerPassword = reqEnv('IMPORTER_PASSWORD')
  const importerAppPassword = reqEnv('IMPORTER_APP_PASSWORD')
  const groupOwnerIdentifier = reqEnv('GROUP_OWNER_IDENTIFIER')
  const serviceDid = process.env.CGS_SERVICE_DID || `did:web:${new URL(cgsUrl).hostname}`

  console.log('CGS URL:        ', cgsUrl)
  console.log('CGS service DID:', serviceDid)
  console.log('Importer:       ', importerIdentifier)
  console.log('Group owner:    ', groupOwnerIdentifier)
  console.log('---')

  // Resolve the importer's DID + PDS from its DID document. The importer signs
  // the import JWT, so its DID is the groupDid (option a: iss === groupDid).
  const idResolver = new IdResolver()
  const importer = await resolveAccount(idResolver, importerIdentifier)
  const groupDid = importer.did
  console.log('Importer DID (groupDid):', groupDid)
  console.log('Importer PDS:           ', importer.pds)

  // 1) Log into the IMPORTER's PDS and mint a service-auth JWT for import.
  console.log('Logging into importer PDS to mint service-auth JWT...')
  const importerAgent = new AtpAgent({ service: importer.pds })
  await importerAgent.login({ identifier: importerIdentifier, password: importerPassword })

  const {
    data: { token },
  } = await importerAgent.com.atproto.server.getServiceAuth({
    aud: serviceDid,
    lxm: IMPORT_NSID,
  })
  console.log('Minted service-auth JWT (aud =', serviceDid + ', lxm =', IMPORT_NSID + ')')

  // The owner identifier may be a handle; the lexicon's ownerDid needs a DID.
  const ownerDid = await resolveToDid(idResolver, groupOwnerIdentifier)

  // 2) Call import on the CGS. ownerDid is the (separately unauthenticated)
  // grantee; groupDid is the importer that just signed the JWT.
  const body = { groupDid, appPassword: importerAppPassword, ownerDid }
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
