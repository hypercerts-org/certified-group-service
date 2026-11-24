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
import { canPerform, type Operation } from '../../rbac/permissions.js'
import { repoScopesCover } from '../../auth/scopes.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid } = auth.credentials
      const input = xrpcInput?.body as {
        repo: string
        collection: string
        rkey: string
        record: { [x: string]: unknown }
      }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, input.repo)

      const groupDb = ctx.groupDbs.get(groupDid)

      // Determine operation based on what's being updated
      const isProfileUpdate = input.collection === 'app.bsky.actor.profile' && input.rkey === 'self'

      let operation: Operation
      let createOnly = false
      if (isProfileUpdate) {
        operation = 'putRecord:profile'
      } else {
        const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`
        const authorRow = await groupDb
          .selectFrom('group_record_authors')
          .select('author_did')
          .where('record_uri', '=', recordUri)
          .executeTakeFirst()

        if (authorRow) {
          operation = authorRow.author_did === callerDid ? 'putOwnRecord' : 'putAnyRecord'
        } else {
          operation = 'createRecord'
        }
      }

      // RBAC check with audit on denial
      const callerRole = await assertCanWithAudit(
        ctx,
        groupDb,
        callerDid,
        operation,
        { collection: input.collection, rkey: input.rkey },
        auth.credentials,
      )

      if (operation === 'createRecord') {
        const hasPutAnyPermission = canPerform(callerRole, 'putAnyRecord')
        const hasPutAnyScope =
          auth.credentials.authKind !== 'apiKey' ||
          repoScopesCover(auth.credentials.scopes ?? [], 'putAnyRecord', input.collection)

        if (hasPutAnyPermission && hasPutAnyScope) {
          operation = 'putAnyRecord'
        } else {
          createOnly = true
        }
      }

      // Forward to group's PDS. Send the resolved group DID as `repo` — the
      // caller may have supplied a handle, which the PDS won't accept. If the
      // caller only passed the create permission, prevent replacement at the
      // PDS rather than relying on the local authorship table being complete.
      const response = await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
        agent.com.atproto.repo.putRecord({
          ...input,
          repo: groupDid,
          ...(createOnly ? { swapRecord: null } : {}),
        }),
      )

      const postOps: Promise<unknown>[] = [
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection,
          rkey: input.rkey,
        }),
      ]
      // Upsert authorship (for new records via putRecord, skip profiles)
      if (!isProfileUpdate) {
        postOps.push(
          groupDb
            .insertInto('group_record_authors')
            .values({
              record_uri: response.data.uri,
              author_did: callerDid,
              collection: input.collection,
            })
            .onConflict((oc) => oc.column('record_uri').doNothing())
            .execute(),
        )
      }
      await Promise.all(postOps)

      return jsonResponse(response.data)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.putRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.putRecord', ctx, config)
}
