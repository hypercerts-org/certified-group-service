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
      const { repo, keyRef } = input?.body as { repo?: string; keyRef: string }

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
      // step time).
      let revokedAt = existing.revoked_at
      if (revokedAt === null) {
        const updated = await groupDb
          .updateTable('group_api_keys')
          .set({ revoked_at: sql<string>`datetime('now')` })
          .where('key_ref', '=', keyRef)
          .where('revoked_at', 'is', null)
          .returning('revoked_at')
          .executeTakeFirstOrThrow()
        revokedAt = updated.revoked_at
      }

      await ctx.audit.log(groupDb, callerDid, 'keys.delete', 'permitted', {
        apiKeyRef: keyRef,
      })

      return jsonResponse({ keyRef, revokedAt: sqliteToIso(revokedAt!) })
    },
  })
}
