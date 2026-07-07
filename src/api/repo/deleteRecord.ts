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
import {
  AUTHORSHIP_COLLECTION,
  authorshipRkey,
  assertNotAuthorshipCollection,
} from '../../authorship.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid } = auth.credentials
      const input = xrpcInput?.body as {
        repo: string
        collection: string
        rkey: string
      }

      // Authorship sidecars are service-managed; a direct delete could erase
      // attribution while its subject record lives on. Sidecars are removed
      // automatically when their subject record is deleted (below).
      assertNotAuthorshipCollection(input.collection)

      const groupDid = await resolveGroupDid(ctx, auth.credentials, input.repo)

      const groupDb = ctx.groupDbs.get(groupDid)
      const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`
      const isAuthor = await ctx.rbac.isAuthor(groupDb, recordUri, callerDid)
      const operation: Operation = isAuthor ? 'deleteOwnRecord' : 'deleteAnyRecord'

      await assertCanWithAudit(
        ctx,
        groupDb,
        callerDid,
        operation,
        { collection: input.collection, rkey: input.rkey },
        auth.credentials,
      )

      // Send the resolved group DID as `repo` — the caller may have supplied a
      // handle, which the PDS won't accept.
      await proxyToPds(ctx.pdsAgents, groupDid, async (agent) => {
        await agent.com.atproto.repo.deleteRecord({ ...input, repo: groupDid })
        // Clean up the authorship sidecar. Separate, best-effort call: the
        // PDS's deleteRecord is idempotent (no-op success when the record is
        // absent), so legacy records without sidecars work; and a failure here
        // must not fail the request — the subject record is already gone.
        // Worst case is an orphaned sidecar, which consumers must ignore once
        // its subject no longer resolves.
        try {
          await agent.com.atproto.repo.deleteRecord({
            repo: groupDid,
            collection: AUTHORSHIP_COLLECTION,
            rkey: authorshipRkey(input.collection, input.rkey),
          })
        } catch (err) {
          ctx.logger.warn(
            { err, collection: input.collection, rkey: input.rkey },
            'Failed to delete authorship sidecar for deleted record',
          )
        }
      })

      await Promise.all([
        groupDb.deleteFrom('group_record_authors').where('record_uri', '=', recordUri).execute(),
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection,
          rkey: input.rkey,
        }),
      ])

      return jsonResponse({})
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.deleteRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.deleteRecord', ctx, config)
}
