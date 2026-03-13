import type { Express } from 'express'
import type { AppContext } from '../context.js'
import roleSet from './role/set.js'
import memberRemove from './member/remove.js'
import putRecord from './repo/putRecord.js'
import createRecord from './repo/createRecord.js'
import uploadBlob from './repo/uploadBlob.js'
import auditQuery from './audit/query.js'
import memberList from './member/list.js'

export function registerRoutes(app: Express, ctx: AppContext): void {
  // Each handler bead appends its import + registration call here.
  // This file starts empty and grows as handler beads are implemented.
  roleSet(app, ctx)
  memberRemove(app, ctx)
  memberList(app, ctx)
  putRecord(app, ctx)
  createRecord(app, ctx)
  uploadBlob(app, ctx)
  auditQuery(app, ctx)
}
