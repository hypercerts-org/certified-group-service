import type { Express } from 'express'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { xrpcHandler } from '../util.js'

export default function (app: Express, ctx: AppContext) {
  app.get('/xrpc/app.certified.group.member.list', xrpcHandler(ctx, async (req, res, { callerDid, groupDid }) => {
    const groupDb = ctx.groupDbs.get(groupDid)

    // RBAC: any member can list members
    await ctx.rbac.assertCan(groupDb, callerDid, 'member.list')

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100)
    const cursor = req.query.cursor as string | undefined

    let query = groupDb
      .selectFrom('group_members')
      .select(['member_did', 'role', 'added_by', 'added_at'])
      .orderBy('added_at', 'asc')
      .orderBy('member_did', 'asc')
      .limit(limit + 1)

    // Cursor: decode base64 → "added_at::member_did"
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8')
      const [cursorTs, cursorDid] = decoded.split('::')
      if (!cursorTs || !cursorDid) throw new XRPCError(400, 'InvalidCursor', 'Invalid cursor')
      query = query.where((eb) =>
        eb.or([
          eb('added_at', '>', cursorTs),
          eb.and([eb('added_at', '=', cursorTs), eb('member_did', '>', cursorDid)]),
        ])
      )
    }

    const rows = await query.execute()
    const hasMore = rows.length > limit
    const members = rows.slice(0, limit)

    let nextCursor: string | undefined
    if (hasMore) {
      const last = members[members.length - 1]
      nextCursor = Buffer.from(`${last.added_at}::${last.member_did}`).toString('base64')
    }

    res.json({
      cursor: nextCursor,
      members: members.map((m) => ({
        did: m.member_did,
        role: m.role,
        addedBy: m.added_by,
        addedAt: m.added_at,
      })),
    })
  }))
}
