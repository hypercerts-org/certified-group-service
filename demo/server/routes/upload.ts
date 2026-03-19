import { Router } from 'express'
import multer from 'multer'
import { createProxyAgent, isSessionExpiredError } from '../oauth/proxy-agent.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

/**
 * POST /api/upload-blob?groupDid=...
 * Accepts multipart file upload, forwards raw bytes to the group service uploadBlob via atproto-proxy.
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not authenticated', sessionExpired: true })
    }

    const groupDid = req.query.groupDid as string
    if (!groupDid) {
      return res.status(400).json({ error: 'Missing groupDid query param' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    const agent = await createProxyAgent(req.session.user.did, groupDid)
    const response = await agent.call(
      'app.certified.group.repo.uploadBlob',
      {},
      new Uint8Array(req.file.buffer),
      { encoding: req.file.mimetype },
    )
    res.json(response.data)
  } catch (err: any) {
    console.error('Upload error:', err.message)
    if (isSessionExpiredError(err)) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(err.status || 500).json({ error: err.message || 'Upload failed' })
  }
})

export default router
