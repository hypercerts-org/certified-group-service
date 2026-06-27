import { useEffect, useState } from 'react'
import { Outlet, Link, useNavigate } from 'react-router-dom'
import { useAuth, useGroup } from '../App'
import { logout, listMyGroups, type MyGroup } from '../api'
import { CopyDid } from './CopyDid'
import { useHandles } from '../useHandles'

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
  select: {
    padding: '3px 8px',
    border: '1px solid #90a4ae',
    borderRadius: 4,
    fontSize: 12,
    maxWidth: 360,
  } as React.CSSProperties,
}

export function Layout() {
  const { user, setUser } = useAuth()
  const { group, setGroup } = useGroup()
  const navigate = useNavigate()

  // The groups the logged-in user belongs to, for the active-group picker. The
  // demo can only operate on groups the caller is a member of (member.list and
  // friends are member-gated), so this list IS the full set of usable groups —
  // there is no value in a free-form "any DID" entry.
  const [myGroups, setMyGroups] = useState<MyGroup[]>([])
  const [groupsError, setGroupsError] = useState('')

  // Reverse-resolve group DIDs so the picker can lead with handles.
  const handles = useHandles(myGroups.map((g) => g.groupDid))

  useEffect(() => {
    if (!user) {
      setMyGroups([])
      return
    }
    let cancelled = false
    setGroupsError('')
    listMyGroups()
      .then((groups) => {
        if (cancelled) return
        setMyGroups(groups)
        // Drop an active group that isn't in the caller's memberships — e.g. a
        // different user logged in on this session, or the group is gone. Stops
        // later requests targeting a group the caller can't act on.
        if (group && !groups.some((g) => g.groupDid === group.did)) setGroup(null)
      })
      .catch((err: any) => {
        if (cancelled) return
        setGroupsError(err.message)
        // Membership unknown — don't keep targeting a possibly-stale group.
        setMyGroups([])
        setGroup(null)
      })
    return () => {
      cancelled = true
    }
    // Re-fetch when the user changes, or after the active group changes (a
    // freshly-registered group should appear in the list without a reload).
  }, [user, group?.did])

  // Auto-select ONLY when the user has exactly one group — there is no choice
  // to make, so picking it for them saves a click. With more than one group we
  // leave the picker on its placeholder so the user consciously chooses (and
  // doesn't silently land on whichever happens to be first). Keying on the
  // membership set keeps this idempotent across re-renders.
  const groupKey = myGroups.map((g) => g.groupDid).join(',')
  useEffect(() => {
    if (myGroups.length !== 1) return
    const only = myGroups[0]
    if (group?.did === only.groupDid) return
    setGroup({ did: only.groupDid, handle: handles[only.groupDid] ?? '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey])

  const handleLogout = async () => {
    await logout()
    setUser(null)
    setGroup(null) // don't carry the active group into the next user's session
    navigate('/login')
  }

  const selectGroup = (did: string) => {
    if (!did) {
      setGroup(null)
      return
    }
    const handle = handles[did]
    // Empty handle is fine — HandleId falls back to the DID and the Dashboard
    // re-resolves the handle on load.
    setGroup({ did, handle: handle ?? '' })
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
        <Link to="/keys" style={styles.link}>API Keys</Link>
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
          <span style={{ fontWeight: 600 }}>Active group:</span>

          {/* Picker over the caller's own memberships. */}
          <select
            style={styles.select}
            value={group?.did ?? ''}
            onChange={(e) => selectGroup(e.target.value)}
          >
            <option value="">— Select a group —</option>
            {myGroups.map((g) => {
              const handle = handles[g.groupDid]
              const label = handle ? `${handle} (${g.role})` : `${g.groupDid} (${g.role})`
              return (
                <option key={g.groupDid} value={g.groupDid}>
                  {label}
                </option>
              )
            })}
          </select>

          {myGroups.length === 0 && !groupsError && (
            <>
              <span style={{ color: '#e65100' }}>You are not in any groups yet.</span>
              <Link to="/register" style={{ color: '#1565c0', fontWeight: 600, textDecoration: 'none' }}>
                Register a new group
              </Link>
            </>
          )}

          {groupsError && (
            <span style={{ color: '#c0392b', fontSize: 11 }}>Couldn’t load your groups: {groupsError}</span>
          )}
        </div>
      )}

      <main style={styles.main}>
        <Outlet />
      </main>
    </>
  )
}
