import type { Generated } from 'kysely'

/** Global tables stored in global.sqlite */
export interface GlobalDatabase {
  groups: GroupsTable
  nonce_cache: NonceCacheTable
  member_index: MemberIndexTable
}

/** Per-group tables stored in per-group SQLite files */
export interface GroupDatabase {
  group_members: GroupMembersTable
  group_record_authors: GroupRecordAuthorsTable
  group_audit_log: GroupAuditLogTable
  group_api_keys: GroupApiKeysTable
}

interface GroupsTable {
  did: string
  pds_url: string
  encrypted_app_password: string
  encrypted_recovery_key: string | null
  created_at: Generated<string>
}

interface NonceCacheTable {
  jti: string
  expires_at: string
}

interface GroupMembersTable {
  member_did: string
  role: 'member' | 'admin' | 'owner'
  added_by: string
  added_at: Generated<string>
}

interface MemberIndexTable {
  member_did: string
  group_did: string
  role: string
  added_by: string
  added_at: Generated<string>
}

interface GroupRecordAuthorsTable {
  record_uri: string
  author_did: string
  collection: string
  created_at: Generated<string>
}

interface GroupAuditLogTable {
  id: Generated<number>
  actor_did: string
  action: string
  collection: string | null
  rkey: string | null
  result: 'permitted' | 'denied'
  detail: string | null // JSON string
  jti: string | null
  created_at: Generated<string>
}

interface GroupApiKeysTable {
  key_ref: string
  key_hash: string
  name: string
  scopes: string // JSON array of @atproto/oauth-scopes scope strings
  created_by: string
  created_at: Generated<string>
  last_used_at: string | null
  revoked_at: string | null
}
