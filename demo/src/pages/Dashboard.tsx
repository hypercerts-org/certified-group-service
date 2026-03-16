import { useState, useEffect } from 'react'
import { useGroup } from '../App'
import { proxyGet, proxyPost } from '../api'
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

const dangerBtn: React.CSSProperties = {
  ...btnStyle,
  background: '#e74c3c',
}

interface Member {
  did: string
  role: string
  addedBy: string
  addedAt: string
}

export function Dashboard() {
  const { group } = useGroup()
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Add member form
  const [newDid, setNewDid] = useState('')
  const [newRole, setNewRole] = useState('member')
  const [actionMsg, setActionMsg] = useState('')

  const groupDid = group?.did || ''

  const fetchMembers = async () => {
    if (!groupDid) return
    setError('')
    setLoading(true)
    try {
      const res = await proxyGet('app.certified.group.member.list', { groupDid })
      setMembers(res.members || [])
    } catch (err: any) {
      setError(err.message)
      setMembers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (groupDid) fetchMembers()
    else setMembers([])
  }, [groupDid]) // eslint-disable-line react-hooks/exhaustive-deps

  const addMember = async () => {
    setActionMsg('')
    try {
      await proxyPost('app.certified.group.member.add', { groupDid, memberDid: newDid, role: newRole })
      setActionMsg(`Added ${newDid} as ${newRole}`)
      setNewDid('')
      fetchMembers()
    } catch (err: any) {
      setActionMsg(`Error: ${err.message}`)
    }
  }

  const removeMember = async (did: string) => {
    setActionMsg('')
    try {
      await proxyPost('app.certified.group.member.remove', { groupDid, memberDid: did })
      setActionMsg(`Removed ${did}`)
      fetchMembers()
    } catch (err: any) {
      setActionMsg(`Error: ${err.message}`)
    }
  }

  const setRole = async (did: string, role: string) => {
    setActionMsg('')
    try {
      await proxyPost('app.certified.group.role.set', { groupDid, memberDid: did, role })
      setActionMsg(`Set ${did} role to ${role}`)
      fetchMembers()
    } catch (err: any) {
      setActionMsg(`Error: ${err.message}`)
    }
  }

  if (!group) {
    return (
      <div>
        <h2 style={{ marginBottom: 16 }}>Dashboard</h2>
        <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
          Select or register a group to get started.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Dashboard</h2>

      {error && <div style={{ color: '#e74c3c', marginBottom: 12, fontSize: 13 }}>{error}</div>}
      {actionMsg && <div style={{ color: '#2196f3', marginBottom: 12, fontSize: 13 }}>{actionMsg}</div>}

      {/* Member table */}
      {members.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24, fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>DID</th>
              <th style={{ padding: 8 }}>Role</th>
              <th style={{ padding: 8 }}>Added By</th>
              <th style={{ padding: 8 }}>Added At</th>
              <th style={{ padding: 8 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.did} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8, fontSize: 12 }}><CopyDid did={m.did} /></td>
                <td style={{ padding: 8 }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontSize: 12,
                    background: m.role === 'owner' ? '#fff3e0' : m.role === 'admin' ? '#e3f2fd' : '#f5f5f5',
                    fontWeight: 600,
                  }}>
                    {m.role}
                  </span>
                </td>
                <td style={{ padding: 8, fontSize: 12 }}><CopyDid did={m.addedBy} /></td>
                <td style={{ padding: 8, fontSize: 12 }}>{new Date(m.addedAt).toLocaleString()}</td>
                <td style={{ padding: 8, display: 'flex', gap: 4 }}>
                  <select
                    onChange={(e) => {
                      if (e.target.value) setRole(m.did, e.target.value)
                      e.target.value = ''
                    }}
                    defaultValue=""
                    style={{ fontSize: 12, padding: '2px 4px' }}
                  >
                    <option value="">Set role...</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                  <button onClick={() => removeMember(m.did)} style={{ ...dangerBtn, padding: '2px 8px', fontSize: 12 }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !loading && (
        <div style={{ color: '#999', textAlign: 'center', padding: 24, marginBottom: 16 }}>
          No members found.{' '}
          <button onClick={fetchMembers} style={{ ...btnStyle, padding: '4px 12px', fontSize: 12 }}>
            Reload
          </button>
        </div>
      )}

      {loading && <div style={{ color: '#999', textAlign: 'center', padding: 24 }}>Loading members...</div>}

      {/* Add member */}
      <div style={{ background: '#fff', padding: 16, borderRadius: 8, border: '1px solid #ddd' }}>
        <h3 style={{ marginBottom: 12, fontSize: 15 }}>Add Member</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={newDid}
            onChange={(e) => setNewDid(e.target.value)}
            placeholder="Member DID (did:plc:...)"
          />
          <select style={inputStyle} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button onClick={addMember} style={btnStyle}>Add</button>
        </div>
      </div>
    </div>
  )
}
