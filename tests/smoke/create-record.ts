/**
 * Smoke test for creating a record in a group's repo via the CGS, acting as the
 * group owner. Exercises the proxied repo path (app.certified.group.repo
 * .createRecord): mint a group-scoped service-auth JWT as the owner, POST a
 * record, report the result.
 *
 * This is a MANUAL smoke test — it hits a live deployment and needs real
 * credentials, so it is not part of the vitest suite (vitest excludes
 * tests/smoke/). Run it by hand with tsx. It assumes the group has already been
 * imported (run import.ts first).
 *
 * Config comes from the same DEDICATED env file as the other smoke scripts
 * (tests/smoke/.env — separate from the repo-root .env, gitignored). The record
 * is written to the group identified by IMPORTER_IDENTIFIER (groupDid); the
 * caller is GROUP_OWNER_* (the owner mints the JWT). Copy tests/smoke/.env.example
 * to tests/smoke/.env.
 *
 * AUTH MODEL — createRecord is group-scoped: the JWT's `aud` must be the GROUP
 * DID (the group must already exist in the CGS), and the issuer must be a member
 * with the createRecord permission. Here we call as the group owner (owner >=
 * member, so it is permitted). This script mints the JWT via the owner's password
 * login (a smoke-test convenience — real callers proxy through the user's PDS;
 * see docs/integration-guide.md).
 *
 * Run from the worktree (has node_modules):
 *   cd .../.claude/worktrees/adam+hyper-469-group-import
 *   npx tsx tests/smoke/create-record.ts
 *
 * Override the env file path with SMOKE_ENV_FILE=/path/to/file if needed.
 */
import { loadSmokeEnv, reqEnv, resolveToDid, resolveAccount } from './lib.js'

// Load ONLY the dedicated smoke-test env file (never the repo-root .env).
loadSmokeEnv(import.meta.url)

import { AtpAgent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'

const CREATE_NSID = 'app.certified.group.repo.createRecord'
const COLLECTION = 'app.bsky.feed.post'

async function main() {
  const cgsUrl = reqEnv('CGS_URL').replace(/\/$/, '')
  const groupOwnerIdentifier = reqEnv('GROUP_OWNER_IDENTIFIER')
  const groupOwnerPassword = reqEnv('GROUP_OWNER_PASSWORD')
  const groupIdentifier = reqEnv('IMPORTER_IDENTIFIER')

  console.log('CGS URL:     ', cgsUrl)
  console.log('Group owner: ', groupOwnerIdentifier)
  console.log('Group:       ', groupIdentifier)
  console.log('---')

  // The group is the imported account; its DID is the JWT aud and the
  // createRecord `repo` field. IMPORTER_IDENTIFIER may be a handle.
  const idResolver = new IdResolver()
  const groupDid = await resolveToDid(idResolver, groupIdentifier)
  console.log('Group DID:', groupDid)

  // Log into the GROUP OWNER's PDS and mint a group-scoped service-auth JWT.
  // aud = the GROUP DID (not the service DID); the owner has createRecord rights.
  const owner = await resolveAccount(idResolver, groupOwnerIdentifier)
  console.log('\nLogging into group owner PDS to mint service-auth JWT...')
  const ownerAgent = new AtpAgent({ service: owner.pds })
  await ownerAgent.login({ identifier: groupOwnerIdentifier, password: groupOwnerPassword })
  console.log('Group owner DID resolved:', ownerAgent.session?.did)

  const {
    data: { token },
  } = await ownerAgent.com.atproto.server.getServiceAuth({
    aud: groupDid,
    lxm: CREATE_NSID,
  })
  console.log('Minted service-auth JWT (aud =', groupDid + ', lxm =', CREATE_NSID + ')')

  // createRecord body. `repo` MUST equal the group DID (the handler rejects a
  // mismatch to prevent cross-repo writes).
  const record = {
    $type: COLLECTION,
    text: 'CGS smoke test post — created by the group owner via the group service.',
    createdAt: new Date().toISOString(),
  }
  const body = { repo: groupDid, collection: COLLECTION, record }

  console.log('---\nPOST', `${cgsUrl}/xrpc/${CREATE_NSID}`)
  console.log('body:', body)

  const res = await fetch(`${cgsUrl}/xrpc/${CREATE_NSID}`, {
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
    console.log('\n✅ createRecord succeeded')
    process.exit(0)
  } else {
    console.log('\n❌ createRecord failed')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n❌ smoke test errored:', err)
  process.exit(1)
})
