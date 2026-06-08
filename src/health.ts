import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from './db/schema.js'
import { getVersion } from './version.js'

/**
 * Build the health-check handler shared by `/health` and `/xrpc/_health`.
 *
 * Reports `{ status, service, version }` on success and a 503 with
 * `{ status: 'error', message }` when the global database is unreachable.
 * The version is resolved once at startup, since it is fixed for the
 * lifetime of the process (see {@link getVersion}).
 */
export function createHealthHandler(globalDb: Kysely<GlobalDatabase>) {
  const version = getVersion()

  return async (_req: Request, res: Response): Promise<void> => {
    try {
      await globalDb.selectFrom('groups').select('did').limit(1).execute()
      res.json({ status: 'ok', service: 'group-service', version })
    } catch {
      res.status(503).json({ status: 'error', message: 'database unreachable' })
    }
  }
}
