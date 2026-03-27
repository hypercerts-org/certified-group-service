import type Database from 'better-sqlite3'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from './schema.js'
import type { GroupDbPool } from './group-db-pool.js'

export interface MemberIndexWriter {
  add(groupRaw: Database.Database, groupDid: string, memberDid: string, role: string, addedBy: string): void
  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void
  updateRole(groupRaw: Database.Database, groupDid: string, memberDid: string, newRole: string): void
}

/** Production: uses ATTACH DATABASE for atomic cross-DB writes. */
export class MemberIndex implements MemberIndexWriter {
  constructor(private globalDbPath: string) {}

  add(groupRaw: Database.Database, groupDid: string, memberDid: string, role: string, addedBy: string): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw.prepare(`INSERT INTO group_members (member_did, role, added_by) VALUES (?, ?, ?)`).run(memberDid, role, addedBy)
      raw.prepare(`INSERT INTO global_db.member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(memberDid, groupDid, role, addedBy)
    })
  }

  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw.prepare(`DELETE FROM group_members WHERE member_did = ?`).run(memberDid)
      raw.prepare(`DELETE FROM global_db.member_index WHERE member_did = ? AND group_did = ?`).run(memberDid, groupDid)
    })
  }

  updateRole(groupRaw: Database.Database, groupDid: string, memberDid: string, newRole: string): void {
    this.withGlobalAttached(groupRaw, (raw) => {
      raw.prepare(`UPDATE group_members SET role = ? WHERE member_did = ?`).run(newRole, memberDid)
      raw.prepare(`UPDATE global_db.member_index SET role = ? WHERE member_did = ? AND group_did = ?`).run(newRole, memberDid, groupDid)
    })
  }

  private withGlobalAttached(groupRaw: Database.Database, fn: (raw: Database.Database) => void): void {
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

  add(groupRaw: Database.Database, groupDid: string, memberDid: string, role: string, addedBy: string): void {
    groupRaw.prepare(`INSERT INTO group_members (member_did, role, added_by) VALUES (?, ?, ?)`).run(memberDid, role, addedBy)
    this.globalRaw.prepare(`INSERT INTO member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(memberDid, groupDid, role, addedBy)
  }

  remove(groupRaw: Database.Database, groupDid: string, memberDid: string): void {
    groupRaw.prepare(`DELETE FROM group_members WHERE member_did = ?`).run(memberDid)
    this.globalRaw.prepare(`DELETE FROM member_index WHERE member_did = ? AND group_did = ?`).run(memberDid, groupDid)
  }

  updateRole(groupRaw: Database.Database, groupDid: string, memberDid: string, newRole: string): void {
    groupRaw.prepare(`UPDATE group_members SET role = ? WHERE member_did = ?`).run(newRole, memberDid)
    this.globalRaw.prepare(`UPDATE member_index SET role = ? WHERE member_did = ? AND group_did = ?`).run(newRole, memberDid, groupDid)
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
