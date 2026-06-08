import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  assertCanWithAudit,
  proxyToPds,
  resolveGroupDid,
  type AuthedMethodConfig,
} from '../util.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid } = auth.credentials
      const input = xrpcInput?.body as {
        repo: string
        collection: string
        rkey?: string
        record: { [x: string]: unknown }
      }

      // The target group is named by the body `repo` (handle or DID, new path)
      // or, for a legacy caller, carried in the credential from `aud`.
      const groupDid = await resolveGroupDid(ctx, auth.credentials, input.repo)

      // RBAC check with audit on denial
      const groupDb = ctx.groupDbs.get(groupDid)
      const operation: Operation = 'createRecord'
      await assertCanWithAudit(ctx, groupDb, callerDid, operation, {
        collection: input.collection,
      })

      // Forward to group's PDS via withAgent. Send the resolved group DID as
      // `repo` — the caller may have supplied a handle, which the PDS won't take.
      const response = await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
        agent.com.atproto.repo.createRecord({ ...input, repo: groupDid }),
      )

      // 4. Track authorship + audit log (independent, run in parallel)
      await Promise.all([
        groupDb
          .insertInto('group_record_authors')
          .values({
            record_uri: response.data.uri,
            author_did: callerDid,
            collection: input.collection,
          })
          .onConflict((oc) => oc.column('record_uri').doNothing())
          .execute(),
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection,
          rkey: response.data.uri.split('/').pop(),
        }),
      ])

      // 5. Return PDS response
      return jsonResponse(response.data)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.createRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.createRecord', ctx, config)
}
