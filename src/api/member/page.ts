import type { Kysely } from 'kysely'
import { XRPCError } from '@atproto/xrpc-server'
import type { GroupDatabase } from '../../db/schema.js'
import { encodeCursor, decodeCursor, sqliteToIso } from '../util.js'

export interface MemberView {
  did: string
  role: string
  addedBy: string
  addedAt: string
}

/**
 * One page of a group's members, oldest first. Shared by `member.list` and the
 * operator-only `admin.listMembers` so both emit the same shape and cursor.
 */
export async function listMembersPage(
  groupDb: Kysely<GroupDatabase>,
  limit: number,
  cursor: string | undefined,
): Promise<{ members: MemberView[]; cursor: string | undefined }> {
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
      ]),
    )
  }

  const rows = await query.execute()
  const page = rows.slice(0, limit)

  let nextCursor: string | undefined
  if (rows.length > limit) {
    const last = page[page.length - 1]
    nextCursor = encodeCursor(`${last.added_at}::${last.member_did}`)
  }

  return {
    cursor: nextCursor,
    members: page.map((m) => ({
      did: m.member_did,
      role: m.role,
      addedBy: m.added_by,
      addedAt: sqliteToIso(m.added_at),
    })),
  }
}
