import { useState } from 'react'
import { Outlet, Link, useNavigate } from 'react-router-dom'
import { useAuth, useGroup } from '../App'
import { logout } from '../api'
import { CopyDid } from './CopyDid'

const styles = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '12px 24px',
    background: '#1a1a2e',
    color: '#fff',
    fontSize: 14,
  } as React.CSSProperties,
  link: {
    color: '#a0c4ff',
    textDecoration: 'none',
  } as React.CSSProperties,
  main: {
    maxWidth: 960,
    margin: '0 auto',
    padding: 24,
  } as React.CSSProperties,
  btn: {
    background: 'none',
    border: '1px solid #a0c4ff',
    color: '#a0c4ff',
    cursor: 'pointer',
    padding: '4px 12px',
    borderRadius: 4,
    fontSize: 13,
  } as React.CSSProperties,
}

export function Layout() {
  const { user, setUser } = useAuth()
  const { group, setGroup } = useGroup()
  const navigate = useNavigate()
  const [showGroupInput, setShowGroupInput] = useState(false)
  const [didInput, setDidInput] = useState('')

  const handleLogout = async () => {
    await logout()
    setUser(null)
    navigate('/login')
  }

  const handleSetGroupDid = () => {
    if (didInput.trim()) {
      setGroup({ did: didInput.trim(), handle: '' })
      setDidInput('')
      setShowGroupInput(false)
    }
  }

  return (
    <>
      <nav style={styles.nav}>
        <strong style={{ marginRight: 8 }}>Group Service Demo</strong>
        <Link to="/" style={styles.link}>Dashboard</Link>
        <Link to="/register" style={styles.link}>Register</Link>
        <Link to="/records" style={styles.link}>Records</Link>
        <Link to="/upload" style={styles.link}>Upload</Link>
        <Link to="/audit" style={styles.link}>Audit</Link>
        <span style={{ flex: 1 }} />
        {user && (
          <>
            <span style={{ fontSize: 13, opacity: 0.8 }}>{user.handle} (<CopyDid did={user.did} truncate style={{ fontSize: 12 }} />)</span>
            <button onClick={handleLogout} style={styles.btn}>Logout</button>
          </>
        )}
      </nav>

      {/* Active group bar */}
      {user && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 24px',
          background: group ? '#e3f2fd' : '#fff3e0',
          borderBottom: '1px solid #ddd',
          fontSize: 13,
        }}>
          {group ? (
            <>
              <span style={{ fontWeight: 600 }}>Active group:</span>
              <code style={{ fontSize: 12, background: '#fff', padding: '2px 8px', borderRadius: 4 }}>
                {group.handle || <CopyDid did={group.did} />}
              </code>
              {group.handle && (
                <CopyDid did={group.did} style={{ opacity: 0.6, fontSize: 11 }} />
              )}
              <button
                onClick={() => setShowGroupInput(!showGroupInput)}
                style={{ ...styles.btn, color: '#1a1a2e', borderColor: '#90a4ae', fontSize: 12, padding: '2px 8px' }}
              >
                Switch
              </button>
              <button
                onClick={() => setGroup(null)}
                style={{ ...styles.btn, color: '#e74c3c', borderColor: '#e74c3c', fontSize: 12, padding: '2px 8px' }}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <span style={{ color: '#e65100' }}>No group selected.</span>
              <Link to="/register" style={{ color: '#1565c0', fontWeight: 600, textDecoration: 'none' }}>
                Register a new group
              </Link>
              <span style={{ color: '#999' }}>or</span>
              <button
                onClick={() => setShowGroupInput(!showGroupInput)}
                style={{ ...styles.btn, color: '#1a1a2e', borderColor: '#90a4ae', fontSize: 12, padding: '2px 8px' }}
              >
                Enter Group DID
              </button>
            </>
          )}
          {showGroupInput && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
              <input
                style={{
                  padding: '3px 8px',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  fontSize: 12,
                  width: 280,
                }}
                value={didInput}
                onChange={(e) => setDidInput(e.target.value)}
                placeholder="did:plc:..."
                onKeyDown={(e) => e.key === 'Enter' && handleSetGroupDid()}
                autoFocus
              />
              <button
                onClick={handleSetGroupDid}
                style={{ ...styles.btn, color: '#1a1a2e', borderColor: '#1a1a2e', fontSize: 12, padding: '2px 8px' }}
              >
                Set
              </button>
            </div>
          )}
        </div>
      )}

      <main style={styles.main}>
        <Outlet />
      </main>
    </>
  )
}
