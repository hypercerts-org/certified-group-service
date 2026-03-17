const EPDS_URL = process.env.EPDS_URL || 'https://epds1.test.certified.app'

let cached: { par: string; authorize: string; token: string } | null = null

/** Fetch (and cache) OAuth Authorization Server metadata. */
export async function getAsMetadata() {
  if (cached) return cached
  const res = await fetch(`${EPDS_URL}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw new Error(`Failed to fetch AS metadata: ${res.status}`)
  const data = (await res.json()) as Record<string, string>
  cached = {
    par: data.pushed_authorization_request_endpoint,
    authorize: data.authorization_endpoint,
    token: data.token_endpoint,
  }
  return cached
}
