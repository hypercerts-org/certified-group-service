const BASE = '/api'

/** Called when a 401 is received — clears state and redirects to login */
let onUnauthorized: (() => void) | null = null

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn
}

async function request<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Only redirect to login when the backend explicitly says the session is dead
    // (not when the group service returns 401 for authorization reasons)
    if (res.status === 401 && path !== '/me' && data.sessionExpired) {
      onUnauthorized?.()
    }
    throw new Error(data.error || data.message || `Request failed (${res.status})`)
  }
  return data as T
}

// Auth — initiates OAuth flow, returns redirect URL
export const login = () =>
  request<{ redirectUrl: string }>('/login', { method: 'POST' })

export const logout = () =>
  request('/logout', { method: 'POST' })

export const getMe = () =>
  request<{ did: string; handle: string }>('/me')

// Register (requires auth — owner DID comes from session, service auth proves DID control)
export const registerGroup = (body: { handle: string }) =>
  request<{ groupDid: string; handle: string }>('/register', { method: 'POST', body: JSON.stringify(body) })

// Proxy — POST
export const proxyPost = (nsid: string, body: Record<string, any>) =>
  request(`/proxy/${nsid}`, { method: 'POST', body: JSON.stringify(body) })

// Proxy — GET
export const proxyGet = (nsid: string, params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString()
  return request(`/proxy/${nsid}?${qs}`)
}

// Upload blob
export const uploadBlob = async (groupDid: string, file: File) => {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/upload-blob?groupDid=${encodeURIComponent(groupDid)}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && data.sessionExpired) onUnauthorized?.()
    throw new Error(data.error || data.message || `Upload failed (${res.status})`)
  }
  return data
}
