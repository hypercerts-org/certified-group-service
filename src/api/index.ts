import type { Express } from 'express'
import type { AppContext } from '../context.js'
import roleSet from './role/set.js'
import memberRemove from './member/remove.js'
import putRecord from './repo/putRecord.js'
import createRecord from './repo/createRecord.js'
import uploadBlob from './repo/uploadBlob.js'
import auditQuery from './audit/query.js'
import memberList from './member/list.js'
import memberAdd from './member/add.js'
import deleteRecord from './repo/deleteRecord.js'
import groupRegister from './group/register.js'

/** Routes that need the raw request stream (no JSON parsing). */
export function registerRawRoutes(app: Express, ctx: AppContext): void {
  uploadBlob(app, ctx)
}

/** Routes that expect a parsed JSON body. */
export function registerJsonRoutes(app: Express, ctx: AppContext): void {
  groupRegister(app, ctx)
  roleSet(app, ctx)
  memberRemove(app, ctx)
  memberList(app, ctx)
  memberAdd(app, ctx)
  putRecord(app, ctx)
  createRecord(app, ctx)
  auditQuery(app, ctx)
  deleteRecord(app, ctx)
}
