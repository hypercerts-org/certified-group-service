import { XRPCError } from '@atproto/xrpc-server'
import type { Express } from 'express'
import type { AppContext } from '../../context.js'
import { xrpcHandler } from '../util.js'
import type { Operation } from '../../rbac/permissions.js'

export default function (app: Express, ctx: AppContext) {
  app.post('/xrpc/com.atproto.repo.uploadBlob', xrpcHandler(ctx, async (req, res, { callerDid, groupDid }) => {
    const groupDb = ctx.groupDbs.get(groupDid)
    const operation: Operation = 'uploadBlob'

    try {
      await ctx.rbac.assertCan(groupDb, callerDid, operation)
    } catch (err) {
      await ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'denied')
      throw err
    }

    // Check Content-Length upfront (fast reject)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
    if (contentLength > ctx.config.maxBlobSize) {
      throw new XRPCError(400, 'BlobTooLarge', 'Blob exceeds size limit')
    }

    // Buffer the blob with mid-stream size enforcement
    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      totalSize += chunk.length
      if (totalSize > ctx.config.maxBlobSize) {
        req.destroy()
        throw new XRPCError(400, 'BlobTooLarge', 'Blob exceeds size limit')
      }
    }
    const blobData = Buffer.concat(chunks)
    const contentType = req.headers['content-type'] ?? 'application/octet-stream'

    // Forward to group's PDS
    const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
      agent.com.atproto.repo.uploadBlob(blobData, { encoding: contentType }),
    )

    await ctx.audit.logAuditEvent(groupDb, callerDid, operation, 'permitted')

    res.json(response.data)
  }))
}
