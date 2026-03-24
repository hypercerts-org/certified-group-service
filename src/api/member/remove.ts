import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import { ROLE_HIERARCHY, type Role } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.member.remove', ctx, {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid, groupDid } = auth.credentials
      const { memberDid } = xrpcInput?.body as { memberDid: string }

      const groupDb = ctx.groupDbs.get(groupDid)

      // Fetch target role and (for non-self removal) RBAC check in parallel
      const [target, callerRole] = await Promise.all([
        groupDb
          .selectFrom('group_members')
          .select('role')
          .where('member_did', '=', memberDid)
          .executeTakeFirst(),
        callerDid !== memberDid
          ? ctx.rbac.assertCan(groupDb, callerDid, 'member.remove')
          : Promise.resolve(null),
      ])

      if (!target) {
        if (callerDid === memberDid) {
          throw new XRPCError(403, 'Not a member of this group', 'Forbidden')
        }
        throw new XRPCError(404, 'Member not found', 'MemberNotFound')
      }

      if (target.role === 'owner') {
        throw new XRPCError(400, 'Cannot remove an owner — demote first', 'CannotRemoveOwner')
      }

      // Cannot remove a member with equal or higher role (non-self removal only)
      if (callerDid !== memberDid && ROLE_HIERARCHY[callerRole!] <= ROLE_HIERARCHY[target.role as Role]) {
        throw new ForbiddenError('Cannot remove a member with equal or higher role')
      }

      await Promise.all([
        groupDb.deleteFrom('group_members')
          .where('member_did', '=', memberDid)
          .execute(),
        ctx.audit.log(groupDb, callerDid, 'member.remove', 'permitted', { memberDid }),
      ])

      return jsonResponse({})
    },
  })
}
