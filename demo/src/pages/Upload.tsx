import { useState, useRef } from 'react'
import { useGroup } from '../App'
import { uploadBlob, proxyPost } from '../api'

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 14,
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#1a1a2e',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
}

export function Upload() {
  const { group } = useGroup()
  const groupDid = group?.did || ''
  const [file, setFile] = useState<File | null>(null)
  const [blobRef, setBlobRef] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Attachment record fields
  const [claimUri, setClaimUri] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [attachResult, setAttachResult] = useState<any>(null)

  const handleUpload = async () => {
    if (!file || !groupDid) return
    setError('')
    setBlobRef(null)
    setLoading(true)
    try {
      const res = await uploadBlob(groupDid, file)
      setBlobRef(res.blob)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const createAttachment = async () => {
    if (!blobRef || !claimUri) return
    setError('')
    setAttachResult(null)
    try {
      const res = await proxyPost('app.certified.group.repo.createRecord', {
        groupDid,
        repo: groupDid,
        collection: 'org.hypercerts.context.attachment',
        record: {
          $type: 'org.hypercerts.context.attachment',
          claim: claimUri,
          title: title || file?.name || 'Untitled',
          description: description || '',
          blob: blobRef,
          createdAt: new Date().toISOString(),
        },
      })
      setAttachResult(res)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) {
      setFile(e.dataTransfer.files[0])
    }
  }

  if (!group) {
    return (
      <div>
        <h2 style={{ marginBottom: 16 }}>Upload Blob</h2>
        <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
          Select or register a group to upload files.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Upload Blob</h2>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInput.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? '#2196f3' : '#ccc'}`,
          borderRadius: 8,
          padding: 40,
          textAlign: 'center',
          cursor: 'pointer',
          background: dragOver ? '#e3f2fd' : '#fafafa',
          marginBottom: 16,
          transition: 'all 0.2s',
        }}
      >
        <input
          ref={fileInput}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.length && setFile(e.target.files[0])}
        />
        {file ? (
          <div>
            <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB, {file.type})
          </div>
        ) : (
          <div style={{ color: '#999' }}>Drop a file here or click to browse</div>
        )}
      </div>

      <button onClick={handleUpload} disabled={loading || !file} style={btnStyle}>
        {loading ? 'Uploading...' : 'Upload'}
      </button>

      {error && <div style={{ color: '#e74c3c', marginTop: 12, fontSize: 13 }}>{error}</div>}

      {blobRef && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 8 }}>Blob Reference</h3>
          <pre
            style={{
              background: '#e8f5e9',
              padding: 12,
              borderRadius: 6,
              fontSize: 13,
              overflow: 'auto',
              cursor: 'pointer',
            }}
            onClick={() => navigator.clipboard.writeText(JSON.stringify(blobRef, null, 2))}
            title="Click to copy"
          >
            {JSON.stringify(blobRef, null, 2)}
          </pre>

          {/* Auto-create attachment */}
          <div style={{ marginTop: 16, background: '#fff', padding: 16, borderRadius: 8, border: '1px solid #ddd' }}>
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Create Attachment Record</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                style={inputStyle}
                value={claimUri}
                onChange={(e) => setClaimUri(e.target.value)}
                placeholder="Claim URI (at://did:plc:.../org.hypercerts.claim.activity/...)"
              />
              <input
                style={inputStyle}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional, defaults to filename)"
              />
              <input
                style={inputStyle}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
              />
              <button onClick={createAttachment} style={btnStyle}>Create Attachment Record</button>
            </div>
            {attachResult && (
              <pre style={{ background: '#e8f5e9', padding: 12, borderRadius: 6, fontSize: 13, marginTop: 12, overflow: 'auto' }}>
                {JSON.stringify(attachResult, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
