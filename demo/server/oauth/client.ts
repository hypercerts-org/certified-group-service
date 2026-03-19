import { NodeOAuthClient } from '@atproto/oauth-client-node'
import type { NodeSavedSessionStore, NodeSavedStateStore } from '@atproto/oauth-client-node'

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || ''
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || ''

// In-memory stores — fine for a demo, swap for Redis/DB in production
const stateStore: NodeSavedStateStore = {
  async get(key) { return states.get(key) },
  async set(key, val) { states.set(key, val) },
  async del(key) { states.delete(key) },
}
const states = new Map<string, any>()

const sessionStore: NodeSavedSessionStore = {
  async get(key) { return sessions.get(key) },
  async set(key, val) { sessions.set(key, val) },
  async del(key) { sessions.delete(key) },
}
const sessions = new Map<string, any>()

export const oauthClient = new NodeOAuthClient({
  clientMetadata: {
    client_id: CLIENT_ID,
    client_name: 'Group Service Demo',
    client_uri: CLIENT_ID.replace('/client-metadata.json', ''),
    redirect_uris: [REDIRECT_URI as `https://${string}`],
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
