import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit } from '../util.js'
import { listMembersPage } from './page.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.member.list', ctx, {
    handler: async ({ auth, params }) => {
      const { callerDid, groupDid, authKind, scopes, apiKeyRef } = auth.credentials
      if (!groupDid) {
        throw new XRPCError(400, 'Missing repo', 'InvalidRequest')
      }
      const groupDb = ctx.groupDbs.get(groupDid)

      // RBAC: any member can list members. For an API key, the scope check
      // (rpc:app.certified.group.member.list) is also enforced here.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'member.list', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined

      const { members, cursor: nextCursor } = await listMembersPage(groupDb, limit, cursor)

      return jsonResponse({
        cursor: nextCursor,
        members,
      })
    },
  })
}
