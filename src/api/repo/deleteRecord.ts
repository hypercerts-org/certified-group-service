import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, type AuthedMethodConfig } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid, groupDid } = auth.credentials
      const input = xrpcInput?.body as { repo: string; collection: string; rkey: string }

      if (input.repo !== groupDid) {
        throw new ForbiddenError('repo field must match the group DID')
      }

      const groupDb = ctx.groupDbs.get(groupDid)
      const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`
      const isAuthor = await ctx.rbac.isAuthor(groupDb, recordUri, callerDid)
      const operation: Operation = isAuthor ? 'deleteOwnRecord' : 'deleteAnyRecord'

      await assertCanWithAudit(ctx, groupDb, callerDid, operation, { collection: input.collection, rkey: input.rkey })

      await ctx.pdsAgents.withAgent(groupDid, (agent) =>
        agent.com.atproto.repo.deleteRecord(input),
      )

      await Promise.all([
        groupDb.deleteFrom('group_record_authors')
          .where('record_uri', '=', recordUri)
          .execute(),
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection, rkey: input.rkey,
        }),
      ])

      return jsonResponse({})
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.deleteRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.deleteRecord', ctx, config)
}
