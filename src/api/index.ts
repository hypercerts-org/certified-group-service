import type { Server } from '@atproto/xrpc-server'
import type { Express } from 'express'
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
import groupRegister from './group/register.js'

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
}

/** Routes that live outside the XRPC server (unauthenticated, non-standard). */
export function registerRawRoutes(app: Express, ctx: AppContext): void {
  groupRegister(app, ctx)
}
