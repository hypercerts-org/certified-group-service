import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import type { ServiceAuthResult } from '../../auth/verifier.js'
import { jsonResponse, encodeCursor, decodeCursor, sqliteToIso } from '../util.js'

export default function (server: Server, ctx: AppContext) {
  server.method('app.certified.groups.membership.list', {
    auth: ctx.authVerifier.xrpcServiceAuth(),
    handler: async ({ auth, params }: { auth: ServiceAuthResult; params: Record<string, unknown> }) => {
      const callerDid = auth.credentials.callerDid

      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined

      let query = ctx.globalDb
        .selectFrom('member_index')
        .select(['group_did', 'role', 'added_at'])
        .where('member_did', '=', callerDid)
        .orderBy('added_at', 'asc')
        .orderBy('group_did', 'asc')
        .limit(limit + 1)

      if (cursor) {
        const decoded = decodeCursor(cursor)
        const [cursorTs, cursorDid] = decoded.split('::')
        if (!cursorTs || !cursorDid) {
          throw new XRPCError(400, 'Invalid cursor', 'InvalidCursor')
        }
        query = query.where((eb) =>
          eb.or([
            eb('added_at', '>', cursorTs),
            eb.and([eb('added_at', '=', cursorTs), eb('group_did', '>', cursorDid)]),
          ]),
        )
      }

      const rows = await query.execute()

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows

      let nextCursor: string | undefined
      if (hasMore) {
        const last = page[page.length - 1]
        nextCursor = encodeCursor(`${last.added_at}::${last.group_did}`)
      }

      return jsonResponse({
        cursor: nextCursor,
        groups: page.map((m) => ({
          groupDid: m.group_did,
          role: m.role,
          joinedAt: sqliteToIso(m.added_at),
        })),
      })
    },
  })
}
