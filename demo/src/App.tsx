import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { getMe, setOnUnauthorized } from './api'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { Dashboard } from './pages/Dashboard'
import { Records } from './pages/Records'
import { Upload } from './pages/Upload'
import { AuditLog } from './pages/AuditLog'

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

  // Restore active group from localStorage
  const [group, setGroupState] = useState<ActiveGroup | null>(() => {
    const stored = localStorage.getItem('activeGroup')
    if (stored) {
      try { return JSON.parse(stored) } catch { /* ignore */ }
    }
    // Migrate from old groupDid-only storage
    const legacyDid = localStorage.getItem('groupDid')
    if (legacyDid) return { did: legacyDid, handle: '' }
    return null
  })

  const setGroup = (g: ActiveGroup | null) => {
    setGroupState(g)
    if (g) {
      localStorage.setItem('activeGroup', JSON.stringify(g))
      localStorage.setItem('groupDid', g.did) // keep legacy key in sync
    } else {
      localStorage.removeItem('activeGroup')
      localStorage.removeItem('groupDid')
    }
  }

  useEffect(() => {
    // When any API call gets a 401, clear auth state so the user is redirected to login
    setOnUnauthorized(() => setUser(null))

    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

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
            </Route>
          </Routes>
        </BrowserRouter>
      </GroupContext.Provider>
    </AuthContext.Provider>
  )
}
