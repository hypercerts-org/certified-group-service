import { NodeOAuthClient } from '@atproto/oauth-client-node'
import type { NodeSavedSessionStore, NodeSavedStateStore } from '@atproto/oauth-client-node'

// In-memory stores — fine for a demo, swap for Redis/DB in production
const states = new Map<string, any>()
const stateStore: NodeSavedStateStore = {
  async get(key) {
    return states.get(key)
  },
  async set(key, val) {
    states.set(key, val)
  },
  async del(key) {
    states.delete(key)
  },
}

const sessions = new Map<string, any>()
const sessionStore: NodeSavedSessionStore = {
  async get(key) {
    return sessions.get(key)
  },
  async set(key, val) {
    sessions.set(key, val)
  },
  async del(key) {
    sessions.delete(key)
  },
}

// Construct lazily: NodeOAuthClient validates client_id/redirect_uri at build
// time (it throws `Invalid URL` on an empty client_id), so building it at module
// load would crash the whole BFF — and the /api/health endpoint with it — when
// OAUTH_CLIENT_ID / OAUTH_REDIRECT_URI aren't set. Deferring construction keeps
// the server bootable; only the OAuth routes fail (with a clear error) until the
// env is configured.
let client: NodeOAuthClient | undefined

export function getOauthClient(): NodeOAuthClient {
  if (client) return client

  const clientId = process.env.OAUTH_CLIENT_ID
  const redirectUri = process.env.OAUTH_REDIRECT_URI
  if (!clientId || !redirectUri) {
    throw new Error(
      'OAuth is not configured: set OAUTH_CLIENT_ID and OAUTH_REDIRECT_URI (see demo/README.md).',
    )
  }

  client = new NodeOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: 'Group Service Demo',
      client_uri: clientId.replace('/client-metadata.json', ''),
      redirect_uris: [redirectUri as `https://${string}`],
      scope: 'atproto transition:generic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
    },
    stateStore,
    sessionStore,
    allowHttp: true,
  })
  return client
}
