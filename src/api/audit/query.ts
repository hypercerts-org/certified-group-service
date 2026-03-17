import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod } from '../util.js'

function parseDetail(s: string | null | undefined): unknown {
  if (!s) return undefined
  try { return JSON.parse(s) } catch { return undefined }
}

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.audit.query', ctx, {
    handler: async ({ auth, params }) => {
      const { callerDid, groupDid } = auth.credentials
      const groupDb = ctx.groupDbs.get(groupDid)

      // RBAC: admin+ can query audit log
      await ctx.rbac.assertCan(groupDb, callerDid, 'audit.query')

      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined
      const actorDid = params.actorDid as string | undefined
      const action = params.action as string | undefined
      const collection = params.collection as string | undefined

      // Newest-first by id DESC
      let query = groupDb
        .selectFrom('group_audit_log')
        .select(['id', 'actor_did', 'action', 'collection', 'rkey', 'result', 'detail', 'created_at'])
        .orderBy('id', 'desc')
        .limit(limit + 1)

      // Optional filters
      if (actorDid) query = query.where('actor_did', '=', actorDid)
      if (action) query = query.where('action', '=', action)
      if (collection) query = query.where('collection', '=', collection)

      // Cursor: decode base64 → id string, WHERE id < cursor
      if (cursor) {
        const cursorId = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10)
        if (isNaN(cursorId)) throw new XRPCError(400, 'Invalid cursor', 'InvalidCursor')
        query = query.where('id', '<', cursorId)
      }

      const rows = await query.execute()
      const hasMore = rows.length > limit
      const entries = rows.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore) {
        const last = entries[entries.length - 1]
        nextCursor = Buffer.from(String(last.id)).toString('base64')
      }

      return {
        encoding: 'application/json' as const,
        body: {
          cursor: nextCursor,
          entries: entries.map((e) => ({
            id: String(e.id),
            actorDid: e.actor_did,
            action: e.action,
            collection: e.collection ?? undefined,
            rkey: e.rkey ?? undefined,
            result: e.result,
            detail: parseDetail(e.detail),
            createdAt: e.created_at,
          })),
        },
      }
    },
  })
}
