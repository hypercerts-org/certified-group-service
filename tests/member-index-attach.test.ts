import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { MemberIndex } from '../src/db/member-index.js'
import { runGlobalMigrations, runGroupMigrations } from '../src/db/migrate.js'
import type { GlobalDatabase, GroupDatabase } from '../src/db/schema.js'

describe('MemberIndex (ATTACH DATABASE)', () => {
  let tmpDir: string
  let globalDbPath: string
  let groupDbPath: string
  let globalRaw: Database.Database
  let groupRaw: Database.Database
  let globalDb: Kysely<GlobalDatabase>
  let groupDb: Kysely<GroupDatabase>
  let memberIndex: MemberIndex

  const groupDid = 'did:plc:testgroup'
  const memberDid = 'did:plc:alice'
  const addedBy = 'did:plc:owner'

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'member-index-test-'))
    globalDbPath = join(tmpDir, 'global.sqlite')
    groupDbPath = join(tmpDir, 'group.sqlite')

    globalRaw = new Database(globalDbPath)
    groupRaw = new Database(groupDbPath)

    globalDb = new Kysely<GlobalDatabase>({
      dialect: new SqliteDialect({ database: globalRaw }),
    })
    groupDb = new Kysely<GroupDatabase>({
      dialect: new SqliteDialect({ database: groupRaw }),
    })

    await runGlobalMigrations(globalDb)
    await runGroupMigrations(groupDb)

    memberIndex = new MemberIndex(globalDbPath)
  })

  afterEach(() => {
    globalRaw.close()
    groupRaw.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('add() writes to both group_members and member_index', async () => {
    memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)

    const groupRow = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .where('member_did', '=', memberDid)
      .executeTakeFirst()
    expect(groupRow).toBeDefined()
    expect(groupRow!.role).toBe('member')

    const indexRow = await globalDb
      .selectFrom('member_index')
      .selectAll()
      .where('member_did', '=', memberDid)
      .where('group_did', '=', groupDid)
      .executeTakeFirst()
    expect(indexRow).toBeDefined()
    expect(indexRow!.role).toBe('member')
    expect(indexRow!.added_by).toBe(addedBy)
  })

  it('remove() deletes from both tables', async () => {
    memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)
    memberIndex.remove(groupRaw, groupDid, memberDid)

    const groupRow = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .where('member_did', '=', memberDid)
      .executeTakeFirst()
    expect(groupRow).toBeUndefined()

    const indexRow = await globalDb
      .selectFrom('member_index')
      .selectAll()
      .where('member_did', '=', memberDid)
      .where('group_did', '=', groupDid)
      .executeTakeFirst()
    expect(indexRow).toBeUndefined()
  })

  it('updateRole() updates both tables', async () => {
    memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)
    memberIndex.updateRole(groupRaw, groupDid, memberDid, 'admin')

    const groupRow = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .where('member_did', '=', memberDid)
      .executeTakeFirst()
    expect(groupRow!.role).toBe('admin')

    const indexRow = await globalDb
      .selectFrom('member_index')
      .selectAll()
      .where('member_did', '=', memberDid)
      .where('group_did', '=', groupDid)
      .executeTakeFirst()
    expect(indexRow!.role).toBe('admin')
  })

  it('add() rolls back group_members on member_index PK violation', async () => {
    memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)

    // Pre-insert a different member in group_members to ensure add() would insert
    // a new group_members row, but the member_index PK (member_did, group_did) already
    // exists — so the transaction should roll back both writes.
    const otherMember = 'did:plc:bob'

    // First, insert into member_index directly to create PK conflict
    globalRaw.prepare(
      `INSERT INTO member_index (member_did, group_did, role, added_by, added_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(otherMember, groupDid, 'member', addedBy)

    // Now try add() which will try to insert into group_members AND member_index.
    // member_index insert should fail (PK violation), rolling back group_members too.
    expect(() => {
      memberIndex.add(groupRaw, groupDid, otherMember, 'member', addedBy)
    }).toThrow()

    // group_members should NOT have the row (rolled back)
    const groupRow = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .where('member_did', '=', otherMember)
      .executeTakeFirst()
    expect(groupRow).toBeUndefined()
  })

  it('DETACH runs even on error — group DB remains usable', async () => {
    // Cause a failure by inserting a duplicate
    memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)
    expect(() => {
      memberIndex.add(groupRaw, groupDid, memberDid, 'member', addedBy)
    }).toThrow()

    // Group DB should still be usable (no stale ATTACH)
    const rows = await groupDb
      .selectFrom('group_members')
      .selectAll()
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].member_did).toBe(memberDid)
  })
})
