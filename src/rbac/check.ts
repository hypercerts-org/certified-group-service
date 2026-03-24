import { Kysely, sql } from 'kysely'
import { canPerform, ROLE_HIERARCHY, type Operation, type Role } from './permissions.js'
import { ForbiddenError } from '../errors.js'
import type { GroupDatabase } from '../db/schema.js'

export class RbacChecker {
  async assertCan(
    groupDb: Kysely<GroupDatabase>,
    memberDid: string,
    operation: Operation,
  ): Promise<Role> {
    const member = await groupDb
      .selectFrom('group_members')
      .select('role')
      .where('member_did', '=', memberDid)
      .executeTakeFirst()

    if (!member) {
      throw new ForbiddenError('Not a member of this group')
    }

    const role = member.role as Role
    if (ROLE_HIERARCHY[role] === undefined) {
      throw new Error(`Invalid role in database: ${role}`)
    }
    if (!canPerform(role, operation)) {
      throw new ForbiddenError(
        `Role '${role}' cannot perform '${operation}'`,
      )
    }

    return role
  }

  async isAuthor(
    groupDb: Kysely<GroupDatabase>,
    recordUri: string,
    memberDid: string,
  ): Promise<boolean> {
    const record = await groupDb
      .selectFrom('group_record_authors')
      .select(sql<1>`1`.as('exists'))
      .where('record_uri', '=', recordUri)
      .where('author_did', '=', memberDid)
      .executeTakeFirst()

    return record !== undefined
  }
}
