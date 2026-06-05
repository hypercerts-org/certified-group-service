import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit } from '../util.js'

/**
 * app.certified.group.destroy — remove a group from the group service.
 *
 * Inverse of register/import: drops the group's stored credentials (groups
 * row), its member index entries, and its per-group database. The underlying
 * PDS account is deliberately left untouched — the service only forgets the
 * group, so the same account can be re-imported later. Requires the owner role.
 *
 * Auth is group-scoped (aud = groupDid): the group still exists at call time,
 * so the normal per-group verifier applies and RBAC gates on the owner role.
 *
 * NOTE (#27): reading the group from the JWT `aud` is the legacy overload to be
 * deprecated. destroy has no request-level group field today, so the #27 fix
 * must add one (e.g. a `groupDid` input) and switch `aud` back to the service
 * DID. See docs/design/api-keys.md (the `aud` overload section).
 *
 * Operation ordering is safety-driven. The global-DB deletes (member index,
 * groups row) run in a single transaction so they can't half-apply, and the
 * irreversible per-group file unlink happens only after that transaction
 * commits. A mid-operation crash therefore leaves at worst an orphaned
 * per-group file (harmless, overwritten on re-import) — never a groups row
 * pointing at a deleted file, nor a cleared index beside a surviving row.
 */
export default function (server: Server, ctx: AppContext) {
  registerAuthedMethod(server, 'app.certified.group.destroy', ctx, {
    handler: async ({ auth }) => {
      const { callerDid, groupDid } = auth.credentials

      // The group must be registered. The verifier already resolved groupDid
      // from the JWT aud, but confirm a row exists so a stale/duplicate call
      // returns a clean 404 rather than silently no-op'ing.
      const group = await ctx.globalDb
        .selectFrom('groups')
        .select('did')
        .where('did', '=', groupDid)
        .executeTakeFirst()
      if (!group) {
        throw new XRPCError(404, 'Group not found', 'GroupNotFound')
      }

      const groupDb = ctx.groupDbs.get(groupDid)

      // Owner-only. Denials are audit-logged to the (still-present) group DB.
      await assertCanWithAudit(ctx, groupDb, callerDid, 'group.destroy')

      // The per-group audit log is about to be deleted, so the durable record
      // of the destroy is the service log, not an audit row.
      ctx.logger.info({ groupDid, callerDid }, 'Destroying group')

      // Remove global-DB state first, then the irreversible per-group file last.
      // The two global deletes run in one transaction so they can't half-apply
      // (e.g. member_index cleared but the groups row left behind, which would
      // leave a registered group with no membership index). Only after the
      // transaction commits do we unlink the per-group file, so an interruption
      // leaves at worst an orphaned file (harmless, overwritten on re-import).
      await ctx.globalDb.transaction().execute(async (trx) => {
        await trx.deleteFrom('member_index').where('group_did', '=', groupDid).execute()
        await trx.deleteFrom('groups').where('did', '=', groupDid).execute()
      })
      await ctx.groupDbs.destroyGroup(groupDid)

      return jsonResponse({ groupDid })
    },
  })
}
