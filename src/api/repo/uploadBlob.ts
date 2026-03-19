import type { Readable } from 'node:stream'
import type { Server } from '@atproto/xrpc-server'
import { registerAuthedMethod, jsonResponse, assertCanWithAudit, type AuthedMethodConfig } from '../util.js'
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
      const groupDb = ctx.groupDbs.get(groupDid)

      await assertCanWithAudit(ctx, groupDb, callerDid, 'uploadBlob')

      // input.body is a Readable stream (framework applied no body parser for */* encoding)
      // input.encoding is the Content-Type header
      const blobData = await streamToBuffer(input?.body as Readable)
      const contentType = input?.encoding ?? 'application/octet-stream'

      const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
        agent.com.atproto.repo.uploadBlob(blobData, { encoding: contentType }),
      )

      await ctx.audit.log(groupDb, callerDid, 'uploadBlob', 'permitted')

      return jsonResponse(response.data)
    },
  }
  registerAuthedMethod(server, 'app.certified.group.repo.uploadBlob', ctx, config)
  registerAuthedMethod(server, 'com.atproto.repo.uploadBlob', ctx, config)
}
