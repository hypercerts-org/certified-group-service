/**
 * Lifecycle bookends for the suite. The shared throwaway test group is imported
 * once in BeforeAll and destroyed in AfterAll, so the records/membership/
 * reporting features can assume a live group without each re-importing.
 *
 * The import is self-cleaning and tolerant of stale data: if a prior run died
 * before its AfterAll, the group is still imported, so import returns
 * GroupAlreadyRegistered (409); we then destroy and re-import to reach a known
 * fresh state. Net: the suite is re-runnable indefinitely against the same
 * account.
 */
import { IdResolver } from '@atproto/identity'
import { testEnv } from './env.js'
import {
  mintServiceAuth,
  callXrpc,
  resolveAccount,
  resolveToDid,
  idResolver,
  type HttpSink,
} from './cgs.js'

const IMPORT_NSID = 'app.certified.group.import'
const DESTROY_NSID = 'app.certified.group.destroy'

/** Resolve the group (importer account) DID + handle and the owner DID. */
export async function resolveGroupAndOwner(): Promise<{
  groupDid: string
  groupHandle: string
  ownerDid: string
}> {
  const resolver: IdResolver = idResolver
  const group = await resolveAccount(resolver, testEnv.importerIdentifier)
  const ownerDid = await resolveToDid(resolver, testEnv.ownerIdentifier)
  return { groupDid: group.did, groupHandle: group.handle, ownerDid }
}

async function importGroup(groupDid: string): Promise<HttpSink> {
  const token = await mintServiceAuth({
    identifier: testEnv.importerIdentifier,
    password: testEnv.importerPassword,
    aud: testEnv.serviceDid,
    lxm: IMPORT_NSID,
  })
  const sink: HttpSink = {}
  await callXrpc(sink, {
    cgsUrl: testEnv.cgsUrl,
    nsid: IMPORT_NSID,
    token,
    body: {
      groupDid,
      appPassword: testEnv.importerAppPassword,
      ownerDid: await resolveToDid(idResolver, testEnv.ownerIdentifier),
    },
  })
  return sink
}

async function destroyGroup(groupDid: string): Promise<HttpSink> {
  const token = await mintServiceAuth({
    identifier: testEnv.ownerIdentifier,
    password: testEnv.ownerPassword,
    aud: groupDid,
    lxm: DESTROY_NSID,
  })
  const sink: HttpSink = {}
  // destroy takes no body — the group comes from the JWT audience.
  await callXrpc(sink, { cgsUrl: testEnv.cgsUrl, nsid: DESTROY_NSID, token })
  return sink
}

/**
 * Ensure the test group is freshly imported. Skips (returns false) when the
 * importer credentials aren't configured — only the @health feature can run
 * then. Otherwise leaves the group imported, tolerating a stale prior import.
 */
export async function ensureGroupImported(): Promise<boolean> {
  if (!testEnv.importerPassword || !testEnv.importerAppPassword) {
    return false
  }
  const { groupDid } = await resolveGroupAndOwner()

  const first = await importGroup(groupDid)
  if (first.lastHttpStatus === 200) return true

  const errorName = (first.lastHttpJson as { error?: string } | undefined)?.error
  if (first.lastHttpStatus === 409 && errorName === 'GroupAlreadyRegistered') {
    // Leftover from a prior run that didn't tear down — destroy and re-import.
    // Check the destroy succeeded first, so a failed cleanup (e.g. 403/500)
    // surfaces its own error rather than a misleading re-import conflict.
    const destroyed = await destroyGroup(groupDid)
    if (destroyed.lastHttpStatus !== 200) {
      throw new Error(
        `ensureGroupImported: stale-data cleanup destroy failed: ` +
          `${destroyed.lastHttpStatus} ${destroyed.lastHttpBody}`,
      )
    }
    const second = await importGroup(groupDid)
    if (second.lastHttpStatus === 200) return true
    throw new Error(
      `ensureGroupImported: re-import after stale-data cleanup failed: ` +
        `${second.lastHttpStatus} ${second.lastHttpBody}`,
    )
  }

  throw new Error(
    `ensureGroupImported: import failed: ${first.lastHttpStatus} ${first.lastHttpBody}`,
  )
}

/**
 * Destroy the test group at suite end. Best-effort — a failure is logged, not
 * thrown, so a teardown hiccup doesn't fail an otherwise-green run (the next
 * run's ensureGroupImported reconciles it).
 */
export async function teardownGroup(): Promise<void> {
  if (!testEnv.ownerPassword) return
  try {
    const { groupDid } = await resolveGroupAndOwner()
    const sink = await destroyGroup(groupDid)
    if (sink.lastHttpStatus !== 200) {
      console.warn(`teardownGroup: destroy returned ${sink.lastHttpStatus} ${sink.lastHttpBody}`)
    }
  } catch (err) {
    console.warn('teardownGroup: best-effort destroy failed:', err)
  }
}
