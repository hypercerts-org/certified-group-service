import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  assertCanWithAudit,
  encodeCursor,
  decodeCursor,
  sqliteToIso,
} from '../util.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.keys.list', ctx, {
    handler: async ({ auth, params }) => {
      const { callerDid, groupDid, authKind, scopes, apiKeyRef } = auth.credentials
      if (!groupDid) {
        throw new XRPCError(400, 'Missing repo', 'InvalidRequest')
      }
      const groupDb = ctx.groupDbs.get(groupDid)

      // Owner-only. An apiKey caller is denied (keys.list has no scope mapping).
      await assertCanWithAudit(ctx, groupDb, callerDid, 'keys.list', undefined, {
        authKind,
        scopes,
        apiKeyRef,
      })

      const limit = (params.limit as number) ?? 50
      const cursor = params.cursor as string | undefined
      const includeRevoked = (params.includeRevoked as boolean) ?? false

      let query = groupDb
        .selectFrom('group_api_keys')
        .select([
          'key_ref',
          'name',
          'scopes',
          'created_by',
          'created_at',
          'last_used_at',
          'revoked_at',
        ])
        .orderBy('created_at', 'asc')
        .orderBy('key_ref', 'asc')
        .limit(limit + 1)

      if (!includeRevoked) {
        query = query.where('revoked_at', 'is', null)
      }

      // Cursor: base64 of "created_at::key_ref" (matches the sort).
      if (cursor) {
        const [cursorTs, cursorRef] = decodeCursor(cursor).split('::')
        if (!cursorTs || !cursorRef) throw new XRPCError(400, 'Invalid cursor', 'InvalidCursor')
        query = query.where((eb) =>
          eb.or([
            eb('created_at', '>', cursorTs),
            eb.and([eb('created_at', '=', cursorTs), eb('key_ref', '>', cursorRef)]),
          ]),
        )
      }

      const rows = await query.execute()
      const hasMore = rows.length > limit
      const keys = rows.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore) {
        const last = keys[keys.length - 1]
        nextCursor = encodeCursor(`${last.created_at}::${last.key_ref}`)
      }

      return jsonResponse({
        cursor: nextCursor,
        keys: keys.map((k) => ({
          keyRef: k.key_ref,
          name: k.name,
          scopes: JSON.parse(k.scopes) as string[],
          createdBy: k.created_by,
          createdAt: sqliteToIso(k.created_at),
          ...(k.last_used_at ? { lastUsedAt: sqliteToIso(k.last_used_at) } : {}),
          ...(k.revoked_at ? { revokedAt: sqliteToIso(k.revoked_at) } : {}),
        })),
      })
    },
  })
}
