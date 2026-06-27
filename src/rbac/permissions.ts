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
}

export function canPerform(userRole: Role, operation: Operation): boolean {
  const requiredLevel = ROLE_HIERARCHY[MIN_ROLE_FOR_OPERATION[operation]]
  const userLevel = ROLE_HIERARCHY[userRole]
  return userLevel >= requiredLevel
}
