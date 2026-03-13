import type { Express } from 'express'
import { XRPCError, type ResponseType } from '@atproto/xrpc-server'
import { ensureValidDid } from '@atproto/syntax'
import type { AppContext } from '../../context.js'
import { xrpcHandler } from '../util.js'
import { ForbiddenError } from '../../errors.js'
import { ASSIGNABLE_ROLES, ROLE_HIERARCHY, type Role } from '../../rbac/permissions.js'

export default function (app: Express, ctx: AppContext) {
  app.post('/xrpc/app.certified.group.member.add', xrpcHandler(ctx, async (req, res, { callerDid, groupDid }) => {
    const { memberDid, role } = req.body

    // Validate inputs before any async work
    ensureValidDid(memberDid)
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new XRPCError(400, `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`, 'InvalidRole')
    }

    const groupDb = ctx.groupDbs.get(groupDid)

    // RBAC check and existence check are independent — run in parallel
    const [callerRole, existing] = await Promise.all([
      ctx.rbac.assertCan(groupDb, callerDid, 'member.add'),
      groupDb
        .selectFrom('group_members')
        .select('member_did')
        .where('member_did', '=', memberDid)
        .executeTakeFirst(),
    ])

    if (existing) {
      throw new XRPCError(409 as ResponseType, 'Member already exists', 'MemberAlreadyExists')
    }

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
        throw new XRPCError(409 as ResponseType, 'Member already exists', 'MemberAlreadyExists')
      }
      throw err
    }

    await ctx.audit.log(groupDb, callerDid, 'member.add', 'permitted', { memberDid, role })

    res.json({
      memberDid: member.member_did,
      role: member.role,
      addedAt: member.added_at,
    })
  }))
}
