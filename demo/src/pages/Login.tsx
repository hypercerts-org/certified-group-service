import { useState } from 'react'
import { login } from '../api'

const btnStyle: React.CSSProperties = {
  padding: '12px 32px',
  background: '#1a1a2e',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 16,
  fontWeight: 600,
}

export function Login() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async () => {
    setError('')
    setLoading(true)
    try {
      const { redirectUrl } = await login()
      // Redirect browser to ePDS for OTP authentication
      window.location.href = redirectUrl
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '80px auto', padding: 24, textAlign: 'center' }}>
      <h2 style={{ marginBottom: 8 }}>Group Service Demo</h2>
      <p style={{ marginBottom: 24, color: '#666', fontSize: 14 }}>
        Sign in with your ePDS account using email verification.
      </p>
      {error && <div style={{ color: '#e74c3c', fontSize: 13, marginBottom: 16 }}>{error}</div>}
      <button onClick={handleLogin} disabled={loading} style={btnStyle}>
        {loading ? 'Redirecting...' : 'Login with ePDS'}
      </button>
    </div>
  )
}
