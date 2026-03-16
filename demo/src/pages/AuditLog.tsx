import { useState } from 'react'
import { useGroup } from '../App'
import { proxyGet } from '../api'
import { CopyDid } from '../components/CopyDid'

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

interface AuditEntry {
  id: string
  actorDid: string
  action: string
  collection?: string
  rkey?: string
  result: string
  detail?: any
  createdAt: string
}

export function AuditLog() {
  const { group } = useGroup()
  const groupDid = group?.did || ''
  const [actorDid, setActorDid] = useState('')
  const [action, setAction] = useState('')
  const [collection, setCollection] = useState('')
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchEntries = async (paginationCursor?: string) => {
    if (!groupDid) return
    setError('')
    setLoading(true)
    try {
      const params: Record<string, string> = { groupDid }
      if (actorDid) params.actorDid = actorDid
      if (action) params.action = action
      if (collection) params.collection = collection
      if (paginationCursor) params.cursor = paginationCursor

      const res = await proxyGet('app.certified.group.audit.query', params)
      if (paginationCursor) {
        setEntries((prev) => [...prev, ...(res.entries || [])])
      } else {
        setEntries(res.entries || [])
      }
      setCursor(res.cursor || null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!group) {
    return (
      <div>
        <h2 style={{ marginBottom: 16 }}>Audit Log</h2>
        <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
          Select or register a group to view audit logs.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Audit Log</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={actorDid}
            onChange={(e) => setActorDid(e.target.value)}
            placeholder="Filter: Actor DID"
          />
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="Filter: Action"
          />
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Filter: Collection"
          />
        </div>
        <button onClick={() => fetchEntries()} disabled={loading} style={btnStyle}>
          {loading ? 'Loading...' : 'Query Audit Log'}
        </button>
      </div>

      {error && <div style={{ color: '#e74c3c', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {entries.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>ID</th>
                <th style={{ padding: 8 }}>Actor</th>
                <th style={{ padding: 8 }}>Action</th>
                <th style={{ padding: 8 }}>Collection</th>
                <th style={{ padding: 8 }}>Rkey</th>
                <th style={{ padding: 8 }}>Result</th>
                <th style={{ padding: 8 }}>Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{e.id}</td>
                  <td style={{ padding: 8, fontSize: 11 }}><CopyDid did={e.actorDid} /></td>
                  <td style={{ padding: 8 }}>{e.action}</td>
                  <td style={{ padding: 8, fontSize: 11 }}>{e.collection || '-'}</td>
                  <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{e.rkey || '-'}</td>
                  <td style={{ padding: 8 }}>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: 8,
                      fontSize: 11,
                      background: e.result === 'permitted' ? '#e8f5e9' : '#ffebee',
                      color: e.result === 'permitted' ? '#2e7d32' : '#c62828',
                    }}>
                      {e.result}
                    </span>
                  </td>
                  <td style={{ padding: 8, fontSize: 11 }}>{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {cursor && (
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button onClick={() => fetchEntries(cursor)} disabled={loading} style={btnStyle}>
                {loading ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}

      {entries.length === 0 && !loading && !error && (
        <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
          No audit entries. Click Query to load.
        </div>
      )}
    </div>
  )
}
