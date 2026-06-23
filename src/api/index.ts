import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../context.js'

import createRecord from './repo/createRecord.js'
import deleteRecord from './repo/deleteRecord.js'
import putRecord from './repo/putRecord.js'
import uploadBlob from './repo/uploadBlob.js'
import memberAdd from './member/add.js'
import memberRemove from './member/remove.js'
import memberList from './member/list.js'
import roleSet from './role/set.js'
import auditQuery from './audit/query.js'
import membershipList from './membership/list.js'
import groupRegister from './group/register.js'
import groupImport from './group/import.js'
import groupDestroy from './group/destroy.js'
import keysCreate from './keys/create.js'
import keysList from './keys/list.js'
import keysDelete from './keys/delete.js'

export function registerXrpcMethods(server: Server, ctx: AppContext): void {
  createRecord(server, ctx)
  deleteRecord(server, ctx)
  putRecord(server, ctx)
  uploadBlob(server, ctx)
  memberAdd(server, ctx)
  memberRemove(server, ctx)
  memberList(server, ctx)
  roleSet(server, ctx)
  auditQuery(server, ctx)
  membershipList(server, ctx)
  groupRegister(server, ctx)
  groupImport(server, ctx)
  groupDestroy(server, ctx)
  keysCreate(server, ctx)
  keysList(server, ctx)
  keysDelete(server, ctx)
}
