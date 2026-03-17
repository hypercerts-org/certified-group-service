import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request } from 'express'
import { AtpAgent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { createDpopFetch } from './dpop-fetch.js'
import type { SessionData } from '../session.js'

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
  return err.status === 401 || err.message?.includes('log in again')
}

/**
 * Creates an AtpAgent for the user's PDS with DPoP-bound OAuth fetch,
 * proxied through the certified_group service to the given group DID.
 */
export function createProxyAgent(session: SessionData, groupDid: string, req?: Request): AtpAgent {
  const agent = new AtpAgent({
    service: session.pdsUrl,
    fetch: createDpopFetch(session, req),
  })
  const proxied = agent.withProxy('certified_group', groupDid) as AtpAgent
  for (const doc of customLexicons) {
    proxied.lex.add(doc)
  }
  return proxied
}
