import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createServer, type Server } from '@atproto/xrpc-server'
import type { LexiconDoc } from '@atproto/lexicon'

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

export function createGroupServer(lexiconDir: string): Server {
  const lexicons = loadLexicons(lexiconDir)
  return createServer(lexicons, {
    validateResponse: false,
    payload: {
      jsonLimit: 1024 * 1024,
      blobLimit: 5 * 1024 * 1024,
    },
  })
}
