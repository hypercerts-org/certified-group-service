import { Router } from 'express'
import multer from 'multer'
import { callGroupService, isSessionExpiredError } from '../oauth/group-client.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

/**
 * POST /api/upload-blob?groupDid=...
 * Accepts multipart file upload, sends raw bytes to the group service directly.
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

    const result = await callGroupService({
      session: req.session.user,
      groupDid,
      nsid: 'com.atproto.repo.uploadBlob',
      method: 'POST',
      rawBody: new Uint8Array(req.file.buffer),
      contentType: req.file.mimetype,
      req,
    })
    res.json(result.data)
  } catch (err: any) {
    console.error('Upload error:', err.message)
    if (isSessionExpiredError(err)) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(err.status || 500).json({ error: err.message || 'Upload failed' })
  }
})

export default router
