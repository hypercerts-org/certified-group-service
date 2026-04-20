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
}

export function canPerform(userRole: Role, operation: Operation): boolean {
  const requiredLevel = ROLE_HIERARCHY[MIN_ROLE_FOR_OPERATION[operation]]
  const userLevel = ROLE_HIERARCHY[userRole]
  return userLevel >= requiredLevel
}
