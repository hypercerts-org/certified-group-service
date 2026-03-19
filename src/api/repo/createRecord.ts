import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, type AuthedMethodConfig } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid, groupDid } = auth.credentials
      const input = xrpcInput?.body as { repo: string; collection: string; rkey?: string; record: { [x: string]: unknown } }

      // 1. Validate repo field matches groupDid (prevent cross-repo writes)
      if (input.repo !== groupDid) {
        throw new ForbiddenError('repo field must match the group DID')
      }

      // 2. RBAC check with audit on denial
      const groupDb = ctx.groupDbs.get(groupDid)
      const operation: Operation = 'createRecord'
      await assertCanWithAudit(ctx, groupDb, callerDid, operation, { collection: input.collection })

      // 3. Forward to group's PDS via withAgent
      const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
        agent.com.atproto.repo.createRecord(input),
      )

      // 4. Track authorship + audit log (independent, run in parallel)
      await Promise.all([
        groupDb.insertInto('group_record_authors')
          .values({
            record_uri: response.data.uri,
            author_did: callerDid,
            collection: input.collection,
          })
          .onConflict((oc) => oc.column('record_uri').doNothing())
          .execute(),
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection, rkey: response.data.uri.split('/').pop(),
        }),
      ])

      // 5. Return PDS response
      return jsonResponse(response.data)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.createRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.createRecord', ctx, config)
}
