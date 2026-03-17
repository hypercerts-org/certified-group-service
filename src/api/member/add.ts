import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import { ensureValidDid } from '@atproto/syntax'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse } from '../util.js'
import { ConflictError, ForbiddenError } from '../../errors.js'
import { ASSIGNABLE_ROLES, ROLE_HIERARCHY, type Role } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.member.add', ctx, {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid, groupDid } = auth.credentials
      const { memberDid, role } = xrpcInput?.body as { memberDid: string; role: Role }

      // Validate inputs before any async work
      ensureValidDid(memberDid)
      if (!ASSIGNABLE_ROLES.includes(role)) {
        throw new XRPCError(400, `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, 'InvalidRole')
      }

      const groupDb = ctx.groupDbs.get(groupDid)

      const callerRole = await ctx.rbac.assertCan(groupDb, callerDid, 'member.add')

      // Cannot assign equal or higher role
      if (ROLE_HIERARCHY[callerRole] <= ROLE_HIERARCHY[role as Role]) {
        throw new ForbiddenError('Cannot assign a role equal to or higher than your own')
      }

      let member
      try {
        member = await groupDb
          .insertInto('group_members')
          .values({ member_did: memberDid, role, added_by: callerDid })
          .returning(['member_did', 'role', 'added_at'])
          .executeTakeFirstOrThrow()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('UNIQUE constraint failed: group_members.member_did')) {
          throw new ConflictError('Member already exists', 'MemberAlreadyExists')
        }
        throw err
      }

      await ctx.audit.log(groupDb, callerDid, 'member.add', 'permitted', { memberDid, role })

      return jsonResponse({
        memberDid: member.member_did,
        role: member.role,
        addedBy: callerDid,
        addedAt: member.added_at,
      })
    },
  })
}
