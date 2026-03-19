import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, encodeCursor, decodeCursor, sqliteToIso } from '../util.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.member.list', ctx, {
    handler: async ({ auth, params }) => {
      const { callerDid, groupDid } = auth.credentials
      const groupDb = ctx.groupDbs.get(groupDid)

      // RBAC: any member can list members
      await assertCanWithAudit(ctx, groupDb, callerDid, 'member.list')

      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined

      let query = groupDb
        .selectFrom('group_members')
        .select(['member_did', 'role', 'added_by', 'added_at'])
        .orderBy('added_at', 'asc')
        .orderBy('member_did', 'asc')
        .limit(limit + 1)

      // Cursor: decode base64 → "added_at::member_did"
      if (cursor) {
        const [cursorTs, cursorDid] = decodeCursor(cursor).split('::')
        if (!cursorTs || !cursorDid) throw new XRPCError(400, 'Invalid cursor', 'InvalidCursor')
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
        nextCursor = encodeCursor(`${last.added_at}::${last.member_did}`)
      }

      return jsonResponse({
        cursor: nextCursor,
        members: members.map((m) => ({
          did: m.member_did,
          role: m.role,
          addedBy: m.added_by,
          addedAt: sqliteToIso(m.added_at),
        })),
      })
    },
  })
}
