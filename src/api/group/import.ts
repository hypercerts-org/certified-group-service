import type { Server } from '@atproto/xrpc-server'
import { AtpAgent } from '@atproto/api'
import { ensureValidDid } from '@atproto/syntax'
import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { registerServiceAuthMethod, jsonResponse } from '../util.js'
import { finalizeGroup } from './finalize.js'

/**
 * app.certified.group.import — promote an existing PDS account into a group.
 *
 * Sibling to group.register: where register creates a new account on the group
 * PDS and signs a PLC op to advertise the certified_group service, import
 * reuses an account that already exists. The caller supplies an app password so
 * the service can act on the account's behalf.
 *
 * import deliberately does NOT touch the account's DID document: service
 * proxying is not currently relied upon (clients call CGS directly), and an app
 * password cannot perform PLC operations anyway (that needs the ACCESS_FULL
 * scope). See docs/design/group-import.md.
 *
 * Auth is service-level (aud = the service DID), because the group does not yet
 * exist in the service. The handler additionally verifies the authenticated
 * caller matches the ownerDid it is about to seed.
 */
export default function (server: Server, ctx: AppContext) {
  registerServiceAuthMethod(server, 'app.certified.group.import', ctx, {
    handler: async ({ auth, input }) => {
      const { callerDid } = auth.credentials
      const { groupDid, appPassword, ownerDid } = input?.body as {
        groupDid: string
        appPassword: string
        ownerDid: string
      }

      // Validate inputs (the lexicon enforces presence + did format; we also
      // guard explicitly so a malformed DID fails as a clean 400)
      try {
        ensureValidDid(groupDid)
      } catch {
        throw new InvalidRequestError('Invalid groupDid')
      }
      try {
        ensureValidDid(ownerDid)
      } catch {
        throw new InvalidRequestError('Invalid ownerDid')
      }

      // The authenticated caller must be the owner they are seeding
      if (callerDid !== ownerDid) {
        throw new AuthRequiredError('Service auth token issuer does not match ownerDid')
      }

      // Resolve the account's PDS and handle from its DID document. An imported
      // account may live on a PDS other than config.groupPdsUrl, so we use the
      // account's own #atproto_pds endpoint rather than assuming a host.
      let atprotoData
      try {
        atprotoData = await ctx.idResolver.did.resolveAtprotoData(groupDid)
      } catch {
        throw new InvalidRequestError(`Could not resolve DID document for ${groupDid}`)
      }
      const pdsUrl = atprotoData.pds
      const handle = atprotoData.handle

      // Authenticate to the account's PDS with the supplied app password. This
      // is a PDS-local createSession against the host PDS itself (no entryway),
      // and both proves the credential works and confirms the account is there.
      const agent = new AtpAgent({ service: pdsUrl })
      try {
        await agent.login({ identifier: groupDid, password: appPassword })
      } catch (err) {
        const e = err as { status?: number; error?: string; message?: string }
        // Bad/revoked app password, or the account is not on the resolved PDS.
        if (e?.status === 401 || e?.status === 400) {
          throw new AuthRequiredError(
            'Could not authenticate to the account PDS with the supplied app password',
            'InvalidAppPassword',
          )
        }
        throw err
      }

      // Persist credentials, init per-group DB, seed owner, audit-log.
      // No recovery key: the service never had genesis control of this account,
      // and an app password cannot grant key control (see design doc).
      await finalizeGroup(ctx, {
        groupDid,
        pdsUrl,
        appPassword,
        ownerDid,
        recoveryKeyMaterial: null,
        action: 'group.import',
        handle,
      })

      return jsonResponse({ groupDid, handle })
    },
  })
}
