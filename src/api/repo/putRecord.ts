import type { Express } from 'express'
import type { AppContext } from '../../context.js'
import { xrpcHandler } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (app: Express, ctx: AppContext) {
  app.post('/xrpc/com.atproto.repo.putRecord', xrpcHandler(ctx, async (req, res, { callerDid, groupDid }) => {
    const input = req.body  // { repo, collection, rkey, record, ... }

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
        if (authorRow.author_did !== callerDid) {
          throw new ForbiddenError('Can only update records you created')
        }
        operation = 'putOwnRecord'
      } else {
        operation = 'createRecord'
      }
    }

    // RBAC check with audit on denial
    try {
      await ctx.rbac.assertCan(groupDb, callerDid, operation)
    } catch (err) {
      await ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'denied', {
        collection: input.collection, rkey: input.rkey, reason: (err as Error).message,
      })
      throw err
    }

    // Forward to group's PDS
    const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
      agent.com.atproto.repo.putRecord(input),
    )

    // Upsert authorship (for new records via putRecord, skip profiles)
    if (!isProfileUpdate) {
      await groupDb.insertInto('group_record_authors')
        .values({
          record_uri: response.data.uri,
          author_did: callerDid,
          collection: input.collection,
        })
        .onConflict((oc) => oc.column('record_uri').doNothing())
        .execute()
    }

    await ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'permitted', {
      collection: input.collection, rkey: input.rkey,
    })

    res.json(response.data)
  }))
}
