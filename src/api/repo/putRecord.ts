import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'com.atproto.repo.putRecord', ctx, {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid, groupDid } = auth.credentials
      const input = xrpcInput?.body as { repo: string; collection: string; rkey: string; record: { [x: string]: unknown } }

      if (input.repo !== groupDid) {
        throw new ForbiddenError('repo field must match the group DID')
      }

      const groupDb = ctx.groupDbs.get(groupDid)

      // Determine operation based on what's being updated
      const isProfileUpdate = input.collection === 'app.bsky.actor.profile' && input.rkey === 'self'

      let operation: Operation
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
      try {
        await ctx.rbac.assertCan(groupDb, callerDid, operation)
      } catch (err) {
        await ctx.audit.log(groupDb, callerDid, operation, 'denied', {
          collection: input.collection, rkey: input.rkey, reason: (err as Error).message,
        })
        throw err
      }

      // Forward to group's PDS
      const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
        agent.com.atproto.repo.putRecord(input),
      )

      const postOps: Promise<unknown>[] = [
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection, rkey: input.rkey,
        }),
      ]
      // Upsert authorship (for new records via putRecord, skip profiles)
      if (!isProfileUpdate) {
        postOps.push(
          groupDb.insertInto('group_record_authors')
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
  })
}
