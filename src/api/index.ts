import type { Express } from 'express'
import type { AppContext } from '../context.js'
import roleSet from './role/set.js'
import memberRemove from './member/remove.js'
import putRecord from './repo/putRecord.js'

export function registerRoutes(app: Express, ctx: AppContext): void {
  // Each handler bead appends its import + registration call here.
  // This file starts empty and grows as handler beads are implemented.
  roleSet(app, ctx)
  memberRemove(app, ctx)
  putRecord(app, ctx)
}
