import type { Server } from '@atproto/xrpc-server'
import { UpstreamFailureError } from '@atproto/xrpc-server'
import { XRPCError as ClientXRPCError } from '@atproto/xrpc'
import type { Agent } from '@atproto/api'
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

/** Output shape shared by putRecord and the applyWrites fallback path. */
interface PutRecordOutput {
  uri: string
  cid: string
  commit?: unknown
  validationStatus?: string
}

/**
 * Does a record exist in the group repo? Distinguishes the PDS's
 * `RecordNotFound` from genuine failures, which are rethrown.
 */
async function recordExists(
  agent: Agent,
  repo: string,
  collection: string,
  rkey: string,
): Promise<boolean> {
  try {
    await agent.com.atproto.repo.getRecord({ repo, collection, rkey })
    return true
  } catch (err) {
    if (err instanceof ClientXRPCError && err.error === 'RecordNotFound') return false
    throw err
  }
}

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    handler: async ({ auth, input: xrpcInput }) => {
      const { callerDid } = auth.credentials
      const input = xrpcInput?.body as {
        repo: string
        collection: string
        rkey: string
        record: { [x: string]: unknown }
        validate?: boolean
        swapCommit?: string
      }

      // Authorship sidecars are service-managed; a direct write could forge
      // attribution.
      assertNotAuthorshipCollection(input.collection)

      const groupDid = await resolveGroupDid(ctx, auth.credentials, input.repo)

      const groupDb = ctx.groupDbs.get(groupDid)

      // Determine operation based on what's being updated
      const isProfileUpdate = input.collection === 'app.bsky.actor.profile' && input.rkey === 'self'
      const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`

      let operation: Operation
      let hasAuthorRow = false
      if (isProfileUpdate) {
        operation = 'putRecord:profile'
      } else {
        const authorRow = await groupDb
          .selectFrom('group_record_authors')
          .select('author_did')
          .where('record_uri', '=', recordUri)
          .executeTakeFirst()

        if (authorRow) {
          hasAuthorRow = true
          operation = authorRow.author_did === callerDid ? 'putOwnRecord' : 'putAnyRecord'
        } else {
          operation = 'createRecord'
        }
      }

      // RBAC check with audit on denial
      await assertCanWithAudit(
        ctx,
        groupDb,
        callerDid,
        operation,
        { collection: input.collection, rkey: input.rkey },
        auth.credentials,
      )

      // Forward to the group's PDS. Send the resolved group DID as `repo` —
      // the caller may have supplied a handle, which the PDS won't accept.
      //
      // Three write shapes:
      // - Profile, or a record with a tracked author: plain putRecord. The
      //   authorship sidecar (if any) is left untouched — attribution is
      //   immutable, an edit does not transfer authorship.
      // - No tracked author + record absent from the PDS: a genuinely new
      //   record. Write it and its authorship sidecar in one applyWrites
      //   commit, mirroring createRecord's atomicity.
      // - No tracked author + record present on the PDS (legacy or imported,
      //   created before authorship tracking): putRecord as before; the edit
      //   attributes the record to the caller (existing semantics), so also
      //   write the sidecar — best-effort, since the subject update has
      //   already been committed.
      let output: PutRecordOutput
      if (isProfileUpdate || hasAuthorRow) {
        const response = await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
          agent.com.atproto.repo.putRecord({ ...input, repo: groupDid }),
        )
        output = response.data
      } else {
        const sidecar = buildAuthorshipRecord({
          subject: recordUri,
          author: callerDid,
          via: auth.credentials.authKind === 'apiKey' ? auth.credentials.apiKeyRef : undefined,
        })
        const sidecarRkey = authorshipRkey(input.collection, input.rkey)

        output = await proxyToPds(ctx.pdsAgents, groupDid, async (agent) => {
          const exists = await recordExists(agent, groupDid, input.collection, input.rkey)
          if (!exists) {
            // See createRecord for the `validate` caveat: the commit-wide flag
            // would reject the sidecar's (PDS-unknown) lexicon when true.
            const response = await agent.com.atproto.repo.applyWrites({
              repo: groupDid,
              ...(input.validate === false ? { validate: false } : {}),
              ...(input.swapCommit !== undefined ? { swapCommit: input.swapCommit } : {}),
              writes: [
                {
                  $type: 'com.atproto.repo.applyWrites#create',
                  collection: input.collection,
                  rkey: input.rkey,
                  value: input.record,
                },
                {
                  $type: 'com.atproto.repo.applyWrites#create',
                  collection: AUTHORSHIP_COLLECTION,
                  rkey: sidecarRkey,
                  value: sidecar,
                },
              ],
            })
            const subjectResult = response.data.results?.[0]
            if (
              subjectResult === undefined ||
              subjectResult.$type !== 'com.atproto.repo.applyWrites#createResult'
            ) {
              throw new UpstreamFailureError(
                'PDS applyWrites returned no result for the created record',
              )
            }
            return {
              uri: subjectResult.uri,
              cid: subjectResult.cid,
              ...(response.data.commit !== undefined ? { commit: response.data.commit } : {}),
              ...(subjectResult.validationStatus !== undefined
                ? { validationStatus: subjectResult.validationStatus }
                : {}),
            }
          }

          const response = await agent.com.atproto.repo.putRecord({ ...input, repo: groupDid })
          try {
            await agent.com.atproto.repo.createRecord({
              repo: groupDid,
              collection: AUTHORSHIP_COLLECTION,
              rkey: sidecarRkey,
              record: sidecar,
            })
          } catch (err) {
            ctx.logger.warn(
              { err, uri: recordUri },
              'Failed to write authorship sidecar for legacy record; run admin.backfillAuthorship to repair',
            )
          }
          return response.data
        })
      }

      const postOps: Promise<unknown>[] = [
        ctx.audit.log(groupDb, callerDid, operation, 'permitted', {
          collection: input.collection,
          rkey: input.rkey,
        }),
      ]
      // Upsert authorship (for new records via putRecord, skip profiles)
      if (!isProfileUpdate) {
        postOps.push(
          groupDb
            .insertInto('group_record_authors')
            .values({
              record_uri: output.uri,
              author_did: callerDid,
              collection: input.collection,
            })
            .onConflict((oc) => oc.column('record_uri').doNothing())
            .execute(),
        )
      }
      await Promise.all(postOps)

      return jsonResponse(output)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.putRecord', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.putRecord', ctx, config)
}
