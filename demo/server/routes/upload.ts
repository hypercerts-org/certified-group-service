import { Router } from 'express'
import multer from 'multer'
import { getServiceAuth } from '../oauth/service-auth.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'

/**
 * POST /api/upload-blob?groupDid=...
 * Accepts multipart file upload, forwards raw bytes to the group service uploadBlob.
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

    const jwt = await getServiceAuth(req.session.user, groupDid, 'com.atproto.repo.uploadBlob', req)

    const response = await fetch(`${GROUP_SERVICE_URL}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: {
        'Content-Type': req.file.mimetype,
        Authorization: `Bearer ${jwt}`,
      },
      body: new Uint8Array(req.file.buffer),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      return res.status(response.status).json(data)
    }

    res.json(data)
  } catch (err: any) {
    console.error('Upload error:', err.message)
    if (err.message?.includes('refresh') || err.message?.includes('log in again') || err.message?.includes('getServiceAuth failed (401)')) {
      return res.status(401).json({ error: 'Session expired — please log in again', sessionExpired: true })
    }
    res.status(500).json({ error: err.message || 'Upload failed' })
  }
})

export default router
