import type { Server } from '@atproto/xrpc-server'
import { XRPCError, AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAdminMethod, jsonResponse, proxyToPds, sqliteToIso } from '../util.js'
import { AUTHORSHIP_COLLECTION, authorshipRkey, buildAuthorshipRecord } from '../../authorship.js'

/** The PDS caps applyWrites at 200 writes per commit. */
const APPLY_WRITES_CHUNK = 200

/**
 * app.certified.group.admin.backfillAuthorship — operator-only, idempotent.
 *
 * Records created before authorship sidecars existed are attributed only in
 * the internal `group_record_authors` table. This endpoint publishes that
 * attribution into the group's repo: for every tracked row whose sidecar is
 * missing, it writes an `app.certified.group.authorship` record (batched via
 * applyWrites), preserving the original author DID and creation timestamp.
 *
 * Idempotency: existing sidecars are enumerated first (listRecords) and their
 * rows skipped, so re-running is safe and cheap.
 *
 * Like all admin endpoints this is HTTP Basic-authenticated against
 * CGS_ADMIN_PASSWORD (see registerAdminMethod) and audit-logged as actor
 * `admin`.
 */
export default function (server: Server, ctx: AppContext) {
  registerAdminMethod(server, 'app.certified.group.admin.backfillAuthorship', ctx, {
    handler: async ({ input }) => {
      const { repo } = input?.body as { repo: string }
      const groupDid = await resolveGroup(ctx, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      // 1. Enumerate sidecars already in the repo, so the backfill is
      //    idempotent.
      const existing = new Set<string>()
      await proxyToPds(ctx.pdsAgents, groupDid, async (agent) => {
        let cursor: string | undefined
        do {
          const res = await agent.com.atproto.repo.listRecords({
            repo: groupDid,
            collection: AUTHORSHIP_COLLECTION,
            limit: 100,
            cursor,
          })
          for (const record of res.data.records) {
            const rkey = record.uri.split('/').pop()
            if (rkey !== undefined) existing.add(rkey)
          }
          cursor = res.data.cursor
        } while (cursor !== undefined)
      })

      // 2. Tracked authorship rows lacking a sidecar. Rows for the sidecar
      //    collection itself are skipped defensively (they should not exist —
      //    direct writes to it are rejected).
      const rows = await groupDb.selectFrom('group_record_authors').selectAll().execute()
      const missing = rows.flatMap((row) => {
        const rkey = row.record_uri.split('/').pop()
        if (rkey === undefined || row.collection === AUTHORSHIP_COLLECTION) return []
        const sidecarRkey = authorshipRkey(row.collection, rkey)
        if (existing.has(sidecarRkey)) return []
        return [{ row, sidecarRkey }]
      })

      // 3. Write the missing sidecars in applyWrites chunks.
      for (let i = 0; i < missing.length; i += APPLY_WRITES_CHUNK) {
        const chunk = missing.slice(i, i + APPLY_WRITES_CHUNK)
        await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
          agent.com.atproto.repo.applyWrites({
            repo: groupDid,
            writes: chunk.map(({ row, sidecarRkey }) => ({
              $type: 'com.atproto.repo.applyWrites#create' as const,
              collection: AUTHORSHIP_COLLECTION,
              rkey: sidecarRkey,
              value: buildAuthorshipRecord({
                subject: row.record_uri,
                author: row.author_did,
                createdAt: sqliteToIso(row.created_at),
              }),
            })),
          }),
        )
      }

      await ctx.audit.log(groupDb, 'admin', 'admin.backfillAuthorship', 'permitted', {
        created: missing.length,
        alreadyPresent: existing.size,
      })

      return jsonResponse({
        groupDid,
        created: missing.length,
        alreadyPresent: existing.size,
        total: rows.length,
      })
    },
  })
}

/** Resolve the `repo` at-identifier to a known group DID (as admin.setOwner). */
async function resolveGroup(ctx: AppContext, repo: string): Promise<string> {
  try {
    return await ctx.authVerifier.resolveRepoToGroup(repo)
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      throw new XRPCError(404, `Unknown group: ${repo}`, 'UnknownGroup')
    }
    throw err
  }
}
