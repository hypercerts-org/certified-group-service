import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit } from '../util.js'
import { ForbiddenError } from '../../errors.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.repo.getRecord', ctx, {
    handler: async ({ auth, params }) => {
      const { callerDid, groupDid } = auth.credentials
      const repo = params.repo as string
      const collection = params.collection as string
      const rkey = params.rkey as string

      if (repo !== groupDid) {
        throw new ForbiddenError('repo field must match the group DID')
      }

      const groupDb = ctx.groupDbs.get(groupDid)
      await assertCanWithAudit(ctx, groupDb, callerDid, 'getRecord', { collection, rkey })

      const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
        agent.com.atproto.repo.getRecord({ repo, collection, rkey }),
      )

      return jsonResponse(response.data)
    },
  })
}
