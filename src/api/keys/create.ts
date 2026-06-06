import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  resolveGroupDid,
  assertCanWithAudit,
  sqliteToIso,
} from '../util.js'
import { generateApiKey } from '../../auth/api-key.js'
import { firstInvalidScope } from '../../auth/scopes.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.keys.create', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes: callerScopes, apiKeyRef } = auth.credentials
      const { repo, name, scopes } = input?.body as {
        repo?: string
        name: string
        scopes: string[]
      }

      if (typeof name !== 'string' || name.length === 0) {
        throw new XRPCError(400, 'name is required', 'InvalidRequest')
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new XRPCError(400, 'At least one scope is required', 'InvalidRequest')
      }
      const bad = firstInvalidScope(scopes)
      if (bad !== null) {
        throw new XRPCError(400, `Invalid scope: ${bad}`, 'InvalidScope')
      }

      const groupDid = await resolveGroupDid(ctx, auth.credentials, repo)
      const groupDb = ctx.groupDbs.get(groupDid)

      // Owner-only. Passing the principal means an apiKey caller is rejected here
      // too: keys.create has no scope mapping, so the scope check denies it — a
      // key cannot mint keys in iteration 1.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'keys.create', undefined, {
        authKind,
        scopes: callerScopes,
        apiKeyRef,
      })

      const key = generateApiKey()

      // Insert and read created_at back: datetime('now') is only resolved at
      // step time, so we cannot know it without selecting it.
      const inserted = await groupDb
        .insertInto('group_api_keys')
        .values({
          key_ref: key.keyRef,
          key_hash: key.hash,
          name,
          scopes: JSON.stringify(scopes),
          created_by: callerDid,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow()

      await ctx.audit.log(groupDb, callerDid, 'keys.create', 'permitted', {
        apiKeyRef: key.keyRef,
        name,
        scopes,
      })

      return jsonResponse({
        keyRef: key.keyRef,
        key: key.plaintext, // returned exactly once
        scopes,
        createdAt: sqliteToIso(inserted.created_at),
      })
    },
  })
}
