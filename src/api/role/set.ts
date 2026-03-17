import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import { ROLE_HIERARCHY, type Role } from '../../rbac/permissions.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.role.set', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, groupDid } = auth.credentials
      const { memberDid, role: newRole } = input?.body as { memberDid: string; role: string }

      if (!(newRole in ROLE_HIERARCHY)) {
        throw new XRPCError(400, `Role must be one of: ${Object.keys(ROLE_HIERARCHY).join(', ')}`, 'InvalidRole')
      }

      const groupDb = ctx.groupDbs.get(groupDid)

      // RBAC check and target lookup are independent — run in parallel
      const [callerRole, target] = await Promise.all([
        ctx.rbac.assertCan(groupDb, callerDid, 'role.set'),
        groupDb
          .selectFrom('group_members')
          .select('role')
          .where('member_did', '=', memberDid)
          .executeTakeFirst(),
      ])
      if (!target) {
        throw new XRPCError(404, 'Member not found', 'MemberNotFound')
      }

      // Cannot promote above own role
      if (ROLE_HIERARCHY[callerRole] < ROLE_HIERARCHY[newRole as Role]) {
        throw new ForbiddenError('Cannot promote above your own role')
      }

      // All updates run inside a transaction. For owner demotions the count check
      // and UPDATE are atomic together, preventing TOCTOU races where two
      // concurrent demotions both pass the guard.
      await groupDb.transaction().execute(async (trx) => {
        if (target.role === 'owner' && newRole !== 'owner') {
          const ownerCount = await trx
            .selectFrom('group_members')
            .where('role', '=', 'owner')
            .select(trx.fn.countAll().as('count'))
            .executeTakeFirstOrThrow()
          if (Number(ownerCount.count) <= 1) {
            throw new XRPCError(400,
              'Cannot demote the last owner — promote a replacement first', 'LastOwnerDemotion')
          }
        }
        await trx.updateTable('group_members')
          .set({ role: newRole as Role })
          .where('member_did', '=', memberDid)
          .execute()
      })

      await ctx.audit.log(groupDb, callerDid, 'role.set', 'permitted', {
        memberDid, previousRole: target.role, newRole,
      })

      return jsonResponse({ memberDid, role: newRole })
    },
  })
}
