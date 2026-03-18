import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, useGroup } from '../App'
import { registerGroup } from '../api'
import { CopyDid } from '../components/CopyDid'

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 14,
}

const btnStyle: React.CSSProperties = {
  padding: '10px 24px',
  background: '#1a1a2e',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
}

export function Register() {
  const { user } = useAuth()
  const { setGroup } = useGroup()
  const navigate = useNavigate()
  const [handle, setHandle] = useState('')
  const [result, setResult] = useState<{ groupDid: string; handle: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const res = await registerGroup({ handle })
      setResult(res)
      setGroup({ did: res.groupDid, handle: res.handle })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!user) {
    return (
      <div>
        <h2 style={{ marginBottom: 16 }}>Register Group</h2>
        <p style={{ color: '#666', fontSize: 14 }}>Log in first to register a group.</p>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Register Group</h2>
      <p style={{ marginBottom: 16, color: '#666', fontSize: 14 }}>
        Create a new group account. You ({user.handle || user.did}) will be the owner.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 500 }}>
        <label>
          <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>Group Name</div>
          <input
            style={inputStyle}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. my-research-group"
            pattern="[a-zA-Z0-9-]+"
            title="Letters, numbers, and hyphens only"
            required
            disabled={!!result}
          />
          <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
            Letters, numbers, and hyphens. This becomes the group's handle on the PDS.
          </div>
        </label>
        {error && <div style={{ color: '#e74c3c', fontSize: 13 }}>{error}</div>}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: '#e8f5e9', padding: 12, borderRadius: 6, fontSize: 13 }}>
              Group created: <strong>{result.handle}</strong>
              <br />
              DID: <CopyDid did={result.groupDid} style={{ fontSize: 12 }} />
            </div>
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{ ...btnStyle, background: '#2e7d32' }}
            >
              Go to Dashboard
            </button>
          </div>
        )}
        {!result && (
          <button type="submit" disabled={loading} style={btnStyle}>
            {loading ? 'Creating...' : 'Create Group'}
          </button>
        )}
      </form>
    </div>
  )
}
