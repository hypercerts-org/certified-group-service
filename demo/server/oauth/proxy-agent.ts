import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { oauthClient } from './client.js'

/** Recursively load all .json lexicon files from a directory. */
function loadLexicons(dir: string): LexiconDoc[] {
  const docs: LexiconDoc[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      docs.push(...loadLexicons(fullPath))
    } else if (extname(entry.name) === '.json') {
      docs.push(JSON.parse(readFileSync(fullPath, 'utf8')))
    }
  }
  return docs
}

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const customLexicons = loadLexicons(
  join(__dirname, '..', '..', '..', 'lexicons', 'app', 'certified'),
)

export function isSessionExpiredError(err: any): boolean {
  // Only treat OAuth-layer failures as session-expired.
  // Upstream XRPC 401s (e.g. "not a member") are authorization errors, not session errors.
  if (err.message?.includes('log in again')) return true
  // OAuthSessionError or token-refresh failures set status 401 but lack XRPC `error` field
  if (err.status === 401 && !err.error) return true
  return false
}

/**
 * Creates an AtpAgent for the user's PDS (via OAuth session),
 * proxied through the certified_group service to the given group DID.
 */
export async function createProxyAgent(userDid: string, groupDid: string): Promise<Agent> {
  const oauthSession = await oauthClient.restore(userDid)
  const agent = new Agent(oauthSession)
  const proxied = agent.withProxy('certified_group', groupDid) as Agent
  for (const doc of customLexicons) {
    proxied.lex.add(doc)
  }
  return proxied
}
