/**
 * Shared helpers for the tests/smoke/* manual scripts: dedicated env loading,
 * required-var lookup, and handle-or-DID resolution. Kept in one place so the
 * three scripts don't each reimplement them.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import type { IdResolver } from '@atproto/identity'

/**
 * Load the DEDICATED smoke-test env file (tests/smoke/.env, sitting next to the
 * scripts) — never the repo-root .env. Pass the calling module's import.meta.url
 * so the path resolves relative to tests/smoke/ regardless of cwd. Exits the
 * process with a hint if the file is missing. Override with SMOKE_ENV_FILE.
 */
export function loadSmokeEnv(callerUrl: string): void {
  const here = dirname(fileURLToPath(callerUrl))
  const envFile = process.env.SMOKE_ENV_FILE || join(here, '.env')
  const loaded = dotenv.config({ path: envFile })
  if (loaded.error) {
    console.error(`Could not read smoke-test env file: ${envFile}`)
    console.error(`Copy ${join(here, '.env.example')} to ${envFile} and fill it in.`)
    process.exit(2)
  }
  console.log(`Loaded smoke-test config from ${envFile}`)
}

/** Read a required env var, exiting with a clear message if it is unset. */
export function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

/**
 * Resolve a handle-or-DID identifier to a DID. The smoke-test env fields accept
 * either (mirroring atproto's login `identifier`), but some uses — DID-document
 * resolution, a JWT `aud` — need an actual DID. A value already starting with
 * `did:` is returned as-is; anything else is treated as a handle and resolved
 * via the identity resolver.
 */
export async function resolveToDid(idResolver: IdResolver, identifier: string): Promise<string> {
  if (identifier.startsWith('did:')) return identifier
  const did = await idResolver.handle.resolve(identifier)
  if (!did) throw new Error(`Could not resolve handle to a DID: ${identifier}`)
  return did
}

/**
 * Resolve a handle-or-DID identifier to its DID, PDS endpoint, and handle, read
 * from the account's DID document. The scripts log in to and address accounts by
 * their published PDS, so it is derived here rather than configured separately.
 */
export async function resolveAccount(
  idResolver: IdResolver,
  identifier: string,
): Promise<{ did: string; pds: string; handle: string }> {
  const did = await resolveToDid(idResolver, identifier)
  const data = await idResolver.did.resolveAtprotoData(did)
  return { did, pds: data.pds, handle: data.handle }
}
