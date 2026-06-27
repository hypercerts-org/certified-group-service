import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { getMe, setOnUnauthorized, resolveHandles } from './api'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { Dashboard } from './pages/Dashboard'
import { Records } from './pages/Records'
import { Upload } from './pages/Upload'
import { AuditLog } from './pages/AuditLog'
import { ApiKeys } from './pages/ApiKeys'

interface AuthUser {
  did: string
  handle: string
}

interface AuthContextType {
  user: AuthUser | null
  setUser: (u: AuthUser | null) => void
  loading: boolean
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  setUser: () => {},
  loading: true,
})

export const useAuth = () => useContext(AuthContext)

// Active group context — shared across all pages
export interface ActiveGroup {
  did: string
  handle: string
}

interface GroupContextType {
  group: ActiveGroup | null
  setGroup: (g: ActiveGroup | null) => void
}

export const GroupContext = createContext<GroupContextType>({
  group: null,
  setGroup: () => {},
})

export const useGroup = () => useContext(GroupContext)

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // The active group is session-only: not persisted. It is derived each load
  // from the user's memberships (auto-selected when there is exactly one,
  // chosen via the picker otherwise — see Layout). Persisting it in
  // localStorage was origin-scoped, not per-user, so it leaked one user's
  // selection to the next user on a shared browser.
  const [group, setGroup] = useState<ActiveGroup | null>(null)

  useEffect(() => {
    // When any API call gets a 401, clear auth state so the user is redirected to login
    setOnUnauthorized(() => setUser(null))

    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  // Backfill the active group's handle when it is missing — e.g. a group
  // auto-selected (or picked) before its handle had finished resolving.
  // Reverse-resolving here means every consumer (banner, page headers) gets the
  // human-readable handle without each having to resolve it. Best-effort: on
  // failure the DID simply remains the display value.
  useEffect(() => {
    if (!group || group.handle) return
    let cancelled = false
    resolveHandles([group.did])
      .then((res) => {
        const handle = res.handles[group.did]
        if (!cancelled && handle) setGroup({ did: group.did, handle })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.did, group?.handle])

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>
  }

  return (
    <AuthContext.Provider value={{ user, setUser, loading }}>
      <GroupContext.Provider value={{ group, setGroup }}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
            <Route element={<Layout />}>
              <Route path="/" element={user ? <Dashboard /> : <Navigate to="/login" />} />
              <Route path="/register" element={<Register />} />
              <Route path="/records" element={user ? <Records /> : <Navigate to="/login" />} />
              <Route path="/upload" element={user ? <Upload /> : <Navigate to="/login" />} />
              <Route path="/audit" element={user ? <AuditLog /> : <Navigate to="/login" />} />
              <Route path="/keys" element={user ? <ApiKeys /> : <Navigate to="/login" />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </GroupContext.Provider>
    </AuthContext.Provider>
  )
}
