import { Agent, AtpAgent } from '@atproto/api'
import { XRPCError } from '@atproto/xrpc-server'
import { decrypt } from './credentials.js'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../db/schema.js'

const EXPIRED_TOKEN_ERROR = 'ExpiredToken'

export class PdsAgentPool {
  private agents = new Map<string, Agent>()
  private pending = new Map<string, Promise<Agent>>()

  constructor(
    private db: Kysely<GlobalDatabase>,
    private encryptionKey: Buffer,
  ) {}

  invalidate(groupDid: string): void {
    this.agents.delete(groupDid)
  }

  async get(groupDid: string): Promise<Agent> {
    const existing = this.agents.get(groupDid)
    if (existing) return existing

    // Dedup concurrent login() calls for the same group
    const pending = this.pending.get(groupDid)
    if (pending) return pending

    const promise = this._login(groupDid)
    this.pending.set(groupDid, promise)
    try {
      const agent = await promise
      this.agents.set(groupDid, agent)
      return agent
    } finally {
      this.pending.delete(groupDid)
    }
  }

  private async _login(groupDid: string): Promise<Agent> {
    const group = await this.db
      .selectFrom('groups')
      .select(['pds_url', 'encrypted_app_password'])
      .where('did', '=', groupDid)
      .executeTakeFirstOrThrow()

    const appPassword = decrypt(group.encrypted_app_password, this.encryptionKey)

    const agent = new AtpAgent({ service: group.pds_url })
    await agent.login({
      identifier: groupDid,
      password: appPassword,
    })

    return agent
  }

  async withAgent<T>(groupDid: string, fn: (agent: Agent) => Promise<T>): Promise<T> {
    const agent = await this.get(groupDid)
    try {
      return await fn(agent)
    } catch (err: unknown) {
      if (err instanceof XRPCError && (err.statusCode === 401 || err.error === EXPIRED_TOKEN_ERROR)) {
        this.invalidate(groupDid)
        const freshAgent = await this.get(groupDid)
        return await fn(freshAgent)
      }
      throw err
    }
  }
}
