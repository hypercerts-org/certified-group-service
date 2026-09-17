export type Role = 'member' | 'admin' | 'owner'

export type Operation =
  | 'createRecord'
  | 'uploadBlob'
  | 'deleteOwnRecord'
  | 'deleteAnyRecord'
  | 'putOwnRecord'
  | 'putAnyRecord'
  | 'putRecord:profile'
  | 'member.add'
  | 'member.remove'
  | 'member.list'
  | 'role.set'
  | 'audit.query'
  | 'group.destroy'
  | 'keys.create'
  | 'keys.list'
  | 'keys.delete'
  | 'ownershipTransfer.propose'
  | 'ownershipTransfer.accept'
  | 'ownershipTransfer.cancel'
  | 'ownershipTransfer.status'

export const ROLE_HIERARCHY: Record<Role, number> = {
  member: 0,
  admin: 1,
  owner: 2,
}

export const ASSIGNABLE_ROLES: Role[] = ['member', 'admin']

const MIN_ROLE_FOR_OPERATION: Record<Operation, Role> = {
  createRecord: 'member',
  uploadBlob: 'member',
  deleteOwnRecord: 'member',
  putOwnRecord: 'member',
  'member.list': 'member',
  putAnyRecord: 'admin',
  deleteAnyRecord: 'admin',
  'putRecord:profile': 'admin',
  'member.add': 'admin',
  'member.remove': 'admin',
  'audit.query': 'admin',
  'role.set': 'owner',
  'group.destroy': 'owner',
  // API-key management is member-level but JWT-authenticated. These ops have no
  // entry in the scope→lxm map (src/auth/scopes.ts), so an apiKey caller can
  // never reach them — a key cannot mint, list, or revoke keys.
  'keys.create': 'member',
  'keys.list': 'member',
  'keys.delete': 'member',
  // Ownership transfer. Only the owner may propose. accept/cancel/status carry
  // a `member` floor because the proposed new owner may be a plain member — the
  // real gate is an identity check in the handler (only the named recipient may
  // accept; only the owner or recipient may cancel/read status), not the role.
  'ownershipTransfer.propose': 'owner',
  'ownershipTransfer.accept': 'member',
  'ownershipTransfer.cancel': 'member',
  'ownershipTransfer.status': 'member',
}

export function canPerform(userRole: Role, operation: Operation): boolean {
  const requiredLevel = ROLE_HIERARCHY[MIN_ROLE_FOR_OPERATION[operation]]
  const userLevel = ROLE_HIERARCHY[userRole]
  return userLevel >= requiredLevel
}
