import type { Express } from 'express'
import type { AppContext } from '../../context.js'
import { xrpcHandler } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (app: Express, ctx: AppContext) {
  app.post('/xrpc/com.atproto.repo.createRecord', xrpcHandler(ctx, async (req, res, { callerDid, groupDid }) => {
    const input = req.body  // { repo, collection, rkey?, record, ... }

    // 1. Validate repo field matches groupDid (prevent cross-repo writes)
    if (input.repo !== groupDid) {
      throw new ForbiddenError('repo field must match the group DID')
    }

    // 2. RBAC check with audit on denial
    const groupDb = ctx.groupDbs.get(groupDid)
    const operation: Operation = 'createRecord'
    try {
      await ctx.rbac.assertCan(groupDb, callerDid, operation)
    } catch (err) {
      await ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'denied', {
        collection: input.collection, reason: (err as Error).message,
      })
      throw err
    }

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
      ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'permitted', {
        collection: input.collection, rkey: response.data.uri.split('/').pop(),
      }),
    ])

    // 5. Return PDS response
    res.json(response.data)
  }))
}
