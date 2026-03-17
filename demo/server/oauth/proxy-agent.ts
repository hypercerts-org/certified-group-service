import type { Request } from 'express'
import { AtpAgent } from '@atproto/api'
import { createDpopFetch } from './dpop-fetch.js'
import type { SessionData } from '../session.js'

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
  return agent.withProxy('certified_group', groupDid) as AtpAgent
}
