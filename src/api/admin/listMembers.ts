import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAdminMethod, jsonResponse } from '../util.js'
import { listMembersPage } from '../member/page.js'
import { resolveGroup } from './resolveGroup.js'

/**
 * app.certified.group.admin.listMembers — operator-only read of a group's
 * members (owner included). Authenticated by HTTP Basic auth against
 * CGS_ADMIN_PASSWORD (see registerAdminMethod), so an operator who is not a
 * member of the group can inspect it. Read-only: nothing is written, not even an
 * audit entry.
 */
export default function (server: Server, ctx: AppContext) {
  registerAdminMethod(server, 'app.certified.group.admin.listMembers', ctx, {
    handler: async ({ params }) => {
      const groupDid = await resolveGroup(ctx, params.repo as string)
      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined

      const { members, cursor: nextCursor } = await listMembersPage(
        ctx.groupDbs.get(groupDid),
        limit,
        cursor,
      )
      return jsonResponse({ cursor: nextCursor, members })
    },
  })
}
