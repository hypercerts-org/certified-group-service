import type { Readable } from 'node:stream'
import type { Server } from '@atproto/xrpc-server'
import { XRPCError } from '@atproto/xrpc-server'
import {
  registerAuthedMethod,
  jsonResponse,
  assertCanWithAudit,
  proxyToPds,
  type AuthedMethodConfig,
} from '../util.js'
import type { AppContext } from '../../context.js'

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export default function (server: Server, ctx: AppContext) {
  const config: AuthedMethodConfig = {
    opts: { blobLimit: ctx.config.maxBlobSize },
    handler: async ({ auth, input }) => {
      const { callerDid, groupDid } = auth.credentials
      // uploadBlob's body is a raw byte stream, so the group cannot ride in the
      // body — it is named by the `repo` querystring (resolved by the verifier)
      // or, for a legacy caller, by the `aud` overload.
      if (!groupDid) {
        throw new XRPCError(400, 'Missing repo', 'InvalidRequest')
      }
      const groupDb = ctx.groupDbs.get(groupDid)

      // input.encoding is the Content-Type header. Pass it as `mime` so an API
      // key is scoped by a `blob:<mime>` permission against this upload's type.
      const contentType = input?.encoding ?? 'application/octet-stream'
      await assertCanWithAudit(
        ctx,
        groupDb,
        callerDid,
        'uploadBlob',
        { mime: contentType },
        auth.credentials,
      )

      // input.body is a Readable stream (framework applied no body parser for */* encoding)
      const blobData = await streamToBuffer(input?.body as Readable)

      const response = await proxyToPds(ctx.pdsAgents, groupDid, (agent) =>
        agent.com.atproto.repo.uploadBlob(blobData, { encoding: contentType }),
      )

      await ctx.audit.log(groupDb, callerDid, 'uploadBlob', 'permitted')

      return jsonResponse(response.data)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.uploadBlob', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.uploadBlob', ctx, config)
}
