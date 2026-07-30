import type { Server } from '@atproto/xrpc-server'
import { UpstreamFailureError } from '@atproto/xrpc-server'
import { TID } from '@atproto/common-web'
import type { AppContext } from '../../context.js'
import {
  registerAuthedMethod,
  jsonResponse,
  assertCanWithAudit,
  proxyToPds,
  resolveGroupDid,
  type AuthedMethodConfig,
} from '../util.js'
import type { Operation } from '../../rbac/permissions.js'
import {
  AUTHORSHIP_COLLECTION,
  authorshipRkey,
  buildAuthorshipRecord,
  assertNotAuthorshipCollection,
} from '../../authorship.js'

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid } = auth.credentials
      const input = xrpcInput?.body as {
        repo: string
        collection: string
        rkey?: string
        record: { [x: string]: unknown }
        validate?: boolean
        swapCommit?: string
      }

      // Authorship sidecars are service-managed; a direct write could forge
      // attribution.
      assertNotAuthorshipCollection(input.collection)

      // The target group is named by the body `repo` (handle or DID, new path)
      // or, for a legacy caller, carried in the credential from `aud`.
      const groupDid = await resolveGroupDid(ctx, auth.credentials, input.repo)

      // RBAC check with audit on denial
      const groupDb = ctx.groupDbs.get(groupDid)
      const operation: Operation = 'createRecord'
      await assertCanWithAudit(
        ctx,
        groupDb,
        callerDid,
        operation,
        { collection: input.collection },
        auth.credentials,
      )

      // Pick the rkey up front (normally the PDS mints a TID server-side): the
      // authorship sidecar embeds the subject's at-uri, so the rkey must be
      // known before the commit is built.
      const rkey = input.rkey !== undefined && input.rkey.length > 0 ? input.rkey : TID.nextStr()
      const subjectUri = `at://${groupDid}/${input.collection}/${rkey}`

      const sidecar = buildAuthorshipRecord({
        subject: subjectUri,
        author: callerDid,
        via: auth.credentials.authKind === 'apiKey' ? auth.credentials.apiKeyRef : undefined,
      })

      // Write the record and its authorship sidecar in ONE applyWrites commit:
      // there is no window in which the record exists unattributed, and both
      // land on the firehose together.
      //
      // `validate` note: applyWrites' flag is commit-wide, and the PDS does not
      // know the app.certified.group.authorship lexicon — `validate: true`
      // would fail the entire commit. So `false` passes through, while `true`
      // degrades to the default (validate known lexicons; the caller's record
      // still gets a validationStatus).
      const response = await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
        agent.com.atproto.repo.applyWrites({
          repo: groupDid,
          ...(input.validate === false ? { validate: false } : {}),
          ...(input.swapCommit !== undefined ? { swapCommit: input.swapCommit } : {}),
          writes: [
            {
              $type: 'com.atproto.repo.applyWrites#create',
              collection: input.collection,
              rkey,
              value: input.record,
            },
            {
              $type: 'com.atproto.repo.applyWrites#create',
              collection: AUTHORSHIP_COLLECTION,
              rkey: authorshipRkey(input.collection, rkey),
              value: sidecar,
            },
          ],
        }),
      )

      const subjectResult = response.data.results?.[0]
      if (
        subjectResult === undefined ||
        subjectResult.$type !== 'com.atproto.repo.applyWrites#createResult'
      ) {
        throw new UpstreamFailureError('PDS applyWrites returned no result for the created record')
      }

      // Track authorship index + audit log (independent, run in parallel). The
      // index mirrors the sidecar for fast RBAC lookups.
      await Promise.all([
        groupDb
          .insertInto('group_record_authors')
          .values({
            record_uri: subjectResult.uri,
            author_did: callerDid,
            collection: input.collection,
          })
          .onConflict((oc) => oc.column('record_uri').doNothing())
          .execute(),
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection,
          rkey,
        }),
      ])

      // Shape the response like com.atproto.repo.createRecord would.
      return jsonResponse({
        uri: subjectResult.uri,
        cid: subjectResult.cid,
        ...(response.data.commit !== undefined ? { commit: response.data.commit } : {}),
        ...(subjectResult.validationStatus !== undefined
          ? { validationStatus: subjectResult.validationStatus }
          : {}),
      })
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.createRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.createRecord', ctx, config)
}
