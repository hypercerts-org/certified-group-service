import type Database from 'better-sqlite3'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from './schema.js'
import type { GroupDbPool } from './group-db-pool.js'

/** `added_by` attribution for an owner installed via the admin setOwner endpoint. */
const OWNER_ADDED_BY = 'admin:setOwner'

export interface MemberIndexWriter {
  add(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    role: string,
    addedBy: string,
  ): void
  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void
  updateRole(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    newRole: string,
  ): void
  /**
   * Atomically reassign ownership: demote `previousOwnerDid` (if any) to admin
   * and make `newOwnerDid` the owner, in a single transaction across both the
   * per-group and global DBs. If `newOwnerDid` is already a member they are
   * promoted in place; otherwise they are inserted as a new owner member (the
   * operator break-glass case, where the new owner need not already belong to
   * the group). Used by the admin `setOwner` endpoint, where leaving a window
   * with two owners or no owner would be incorrect.
   */
  transferOwner(
    groupRaw: Database.Database,
    groupDid: string,
    newOwnerDid: string,
    previousOwnerDid: string | null,
  ): void
}

/** Production: uses ATTACH DATABASE for atomic cross-DB writes. */
export class MemberIndex implements MemberIndexWriter {
  constructor(private globalDbPath: string) {}

  add(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    role: string,
    addedBy: string,
  ): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw
        .prepare(`INSERT INTO group_members (member_did, role, added_by) VALUES (?, ?, ?)`)
        .run(memberDid, role, addedBy)
      const row = raw
        .prepare(`SELECT added_at FROM group_members WHERE member_did = ?`)
        .get(memberDid) as { added_at: string }
      raw
        .prepare(
          `INSERT INTO global_db.member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(memberDid, groupDid, role, addedBy, row.added_at)
    })
  }

  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw.prepare(`DELETE FROM group_members WHERE member_did = ?`).run(memberDid)
      raw
        .prepare(`DELETE FROM global_db.member_index WHERE member_did = ? AND group_did = ?`)
        .run(memberDid, groupDid)
    })
  }

  updateRole(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    newRole: string,
  ): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw.prepare(`UPDATE group_members SET role = ? WHERE member_did = ?`).run(newRole, memberDid)
      raw
        .prepare(
          `UPDATE global_db.member_index SET role = ? WHERE member_did = ? AND group_did = ?`,
        )
        .run(newRole, memberDid, groupDid)
    })
  }

  transferOwner(
    groupRaw: Database.Database,
    groupDid: string,
    newOwnerDid: string,
    previousOwnerDid: string | null,
  ): void {
    // withGlobalAttached runs this callback inside a single SQLite transaction
    // (groupRaw.transaction(...)), so the demote and the promote/insert below
    // commit together or not at all. A crash partway through rolls the whole
    // thing back — the group is never left with the old owner demoted to admin
    // but no new owner installed.
    this.withGlobalAttached(groupRaw, (raw) => {
      const setRole = (memberDid: string, role: string): void => {
        raw.prepare(`UPDATE group_members SET role = ? WHERE member_did = ?`).run(role, memberDid)
        raw
          .prepare(
            `UPDATE global_db.member_index SET role = ? WHERE member_did = ? AND group_did = ?`,
          )
          .run(role, memberDid, groupDid)
      }
      if (previousOwnerDid && previousOwnerDid !== newOwnerDid) setRole(previousOwnerDid, 'admin')

      // The new owner may not yet be a member (operator break-glass). Insert
      // them as owner in that case; otherwise promote the existing row.
      const exists = raw
        .prepare(`SELECT 1 FROM group_members WHERE member_did = ?`)
        .get(newOwnerDid)
      if (exists) {
        setRole(newOwnerDid, 'owner')
      } else {
        raw
          .prepare(`INSERT INTO group_members (member_did, role, added_by) VALUES (?, 'owner', ?)`)
          .run(newOwnerDid, OWNER_ADDED_BY)
        const { added_at } = raw
          .prepare(`SELECT added_at FROM group_members WHERE member_did = ?`)
          .get(newOwnerDid) as { added_at: string }
        raw
          .prepare(
            `INSERT INTO global_db.member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)`,
          )
          .run(newOwnerDid, groupDid, OWNER_ADDED_BY, added_at)
      }
    })
  }

  private withGlobalAttached(
    groupRaw: Database.Database,
    fn: (raw: Database.Database) => void,
  ): void {
    groupRaw.prepare('ATTACH DATABASE ? AS global_db').run(this.globalDbPath)
    try {
      groupRaw.transaction(() => fn(groupRaw))()
    } finally {
      groupRaw.exec('DETACH DATABASE global_db')
    }
  }
}

/** Test: writes sequentially via raw connections (no ATTACH needed for in-memory DBs). */
export class TestMemberIndex implements MemberIndexWriter {
  constructor(private globalRaw: Database.Database) {}

  add(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    role: string,
    addedBy: string,
  ): void {
    groupRaw
      .prepare(`INSERT INTO group_members (member_did, role, added_by) VALUES (?, ?, ?)`)
      .run(memberDid, role, addedBy)
    const row = groupRaw
      .prepare(`SELECT added_at FROM group_members WHERE member_did = ?`)
      .get(memberDid) as { added_at: string }
    this.globalRaw
      .prepare(
        `INSERT INTO member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memberDid, groupDid, role, addedBy, row.added_at)
  }

  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void {
    groupRaw.prepare(`DELETE FROM group_members WHERE member_did = ?`).run(memberDid)
    this.globalRaw
      .prepare(`DELETE FROM member_index WHERE member_did = ? AND group_did = ?`)
      .run(memberDid, groupDid)
  }

  updateRole(
    groupRaw: Database.Database,
    groupDid: string,
    memberDid: string,
    newRole: string,
  ): void {
    groupRaw
      .prepare(`UPDATE group_members SET role = ? WHERE member_did = ?`)
      .run(newRole, memberDid)
    this.globalRaw
      .prepare(`UPDATE member_index SET role = ? WHERE member_did = ? AND group_did = ?`)
      .run(newRole, memberDid, groupDid)
  }

  transferOwner(
    groupRaw: Database.Database,
    groupDid: string,
    newOwnerDid: string,
    previousOwnerDid: string | null,
  ): void {
    if (previousOwnerDid && previousOwnerDid !== newOwnerDid) {
      this.updateRole(groupRaw, groupDid, previousOwnerDid, 'admin')
    }
    const exists = groupRaw
      .prepare(`SELECT 1 FROM group_members WHERE member_did = ?`)
      .get(newOwnerDid)
    if (exists) {
      this.updateRole(groupRaw, groupDid, newOwnerDid, 'owner')
    } else {
      this.add(groupRaw, groupDid, newOwnerDid, 'owner', OWNER_ADDED_BY)
    }
  }
}

/** One-time backfill: populates member_index from existing group DBs. Idempotent. */
export async function backfillMemberIndex(
  globalDb: Kysely<GlobalDatabase>,
  groupDbs: GroupDbPool,
): Promise<number> {
  const groups = await globalDb.selectFrom('groups').select('did').execute()
  let count = 0
  for (const group of groups) {
    const groupDb = groupDbs.get(group.did)
    const members = await groupDb
      .selectFrom('group_members')
      .select(['member_did', 'role', 'added_by', 'added_at'])
      .execute()
    for (const m of members) {
      await globalDb
        .insertInto('member_index')
        .values({
          member_did: m.member_did,
          group_did: group.did,
          role: m.role,
          added_by: m.added_by,
          added_at: m.added_at,
        })
        .onConflict((oc) =>
          oc.columns(['member_did', 'group_did']).doUpdateSet({
            role: m.role,
            added_by: m.added_by,
            added_at: m.added_at,
          }),
        )
        .execute()
      count++
    }
  }
  return count
}
