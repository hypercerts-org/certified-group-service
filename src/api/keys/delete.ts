import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import { sql } from 'kysely'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  resolveGroupDid,
  assertCanWithAudit,
  sqliteToIso,
} from '../util.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.keys.delete', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes, apiKeyRef } = auth.credentials
      // The framework validates required lexicon input before the handler, so a
      // missing/empty body is already a 400; default to {} as belt-and-braces so
      // the destructure can never throw a 500 if that ever changes.
      const { repo, keyRef } = (input?.body ?? {}) as { repo?: string; keyRef?: string }

      if (typeof keyRef !== 'string' || keyRef.length === 0) {
        throw new XRPCError(400, 'keyRef is required', 'InvalidRequest')
      }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      // Owner-only. An apiKey caller is denied (keys.delete has no scope mapping).
      await assertCanWithAudit(ctx, groupDb, callerDid, 'keys.delete', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      const existing = await groupDb
        .selectFrom('group_api_keys')
        .select(['revoked_at'])
        .where('key_ref', '=', keyRef)
        .executeTakeFirst()
      if (!existing) {
        throw new XRPCError(404, 'API key not found', 'KeyNotFound')
      }

      // Idempotent: a revoked key keeps its original revocation time. Only set it
      // on the first revocation, then read it back (datetime('now') resolves at
      // step time). The `revoked_at is null` guard makes concurrent deletes safe:
      // exactly one UPDATE matches; the loser matches 0 rows and re-reads the
      // winner's timestamp rather than erroring.
      let revokedAt = existing.revoked_at
      if (revokedAt === null) {
        const updated = await groupDb
          .updateTable('group_api_keys')
          .set({ revoked_at: sql<string>`datetime('now')` })
          .where('key_ref', '=', keyRef)
          .where('revoked_at', 'is', null)
          .returning('revoked_at')
          .executeTakeFirst()
        if (updated) {
          revokedAt = updated.revoked_at
        } else {
          /* c8 ignore start -- TOCTOU race: only hit if a concurrent request
             revoked the same key between our existence check and this UPDATE.
             In-memory SQLite serialises test requests, so this branch is not
             deterministically reachable in unit tests. */
          // Lost a concurrent revoke: the key is already revoked. Read the
          // winner's timestamp so the response is still correct (not a 500).
          const current = await groupDb
            .selectFrom('group_api_keys')
            .select('revoked_at')
            .where('key_ref', '=', keyRef)
            .executeTakeFirst()
          revokedAt = current?.revoked_at ?? null
          /* c8 ignore stop */
        }
      }

      /* c8 ignore start -- only reachable if the row was deleted between the
         existence check above and the re-read in the race branch; not
         deterministically reachable in tests. */
      if (revokedAt === null) {
        throw new XRPCError(404, 'API key not found', 'KeyNotFound')
      }
      /* c8 ignore stop */

      // `revokedKeyRef` (the key this action revoked), distinct from `apiKeyRef`
      // which attributes an action performed *by* a key (see assertCanWithAudit).
      await ctx.audit.log(groupDb, callerDid, 'keys.delete', 'permitted', {
        revokedKeyRef: keyRef,
      })

      return jsonResponse({ keyRef, revokedAt: sqliteToIso(revokedAt) })
    },
  })
}
