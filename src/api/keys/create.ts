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
import { canonicalizeScopes, expandIncludes } from '../../auth/scopes.js'

export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.keys.create', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid, authKind, scopes: callerScopes, apiKeyRef } = auth.credentials
      // Default to {} so the destructure can't 500 on an absent body (the
      // framework already rejects missing required input with a 400).
      const { repo, name, scopes } = (input?.body ?? {}) as {
        repo?: string
        name?: string
        scopes?: string[]
      }

      if (typeof name !== 'string' || name.length === 0) {
        throw new XRPCError(400, 'name is required', 'InvalidRequest')
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new XRPCError(400, 'At least one scope is required', 'InvalidRequest')
      }

      // Expand any `include:<nsid>` permission-set scopes to the concrete
      // `rpc:`/`repo:` scopes they bundle (resolved via Lexicon resolution), then
      // canonicalize. A key stores only concrete scopes — the `include:` is a
      // create-time convenience and is never persisted. Non-`include:` scopes
      // pass through untouched.
      const expanded = await expandIncludes(scopes, ctx.config.serviceDid, ctx.permissionSets)
      if (!expanded.ok) {
        throw new XRPCError(
          400,
          `Invalid scope: ${expanded.scope} (${expanded.reason})`,
          'InvalidScope',
        )
      }

      // Canonicalize to this service's stored form: a key only ever calls the
      // CGS it was minted on, so we append our own scope `aud`. A friendly
      // `rpc:<lxm>` is expanded; an already-canonical scope is accepted only if
      // its `aud` is ours — a foreign service DID or wrong service fragment is
      // rejected rather than stored as a dead grant.
      const canon = canonicalizeScopes(expanded.scopes, ctx.config.serviceDid)
      if (!canon.ok) {
        throw new XRPCError(400, `Invalid scope: ${canon.scope} (${canon.reason})`, 'InvalidScope')
      }
      const storedScopes = canon.scopes

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
          scopes: JSON.stringify(storedScopes),
          created_by: callerDid,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow()

      // `createdKeyRef` (the key this action created), distinct from `apiKeyRef`
      // which attributes an action performed *by* a key (see assertCanWithAudit).
      await ctx.audit.log(groupDb, callerDid, 'keys.create', 'permitted', {
        createdKeyRef: key.keyRef,
        name,
        scopes: storedScopes,
      })

      return jsonResponse({
        keyRef: key.keyRef,
        key: key.plaintext, // returned exactly once
        scopes: storedScopes,
        createdAt: sqliteToIso(inserted.created_at),
      })
    },
  })
}
