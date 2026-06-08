const BASE = '/api'

/** Called when a 401 is received — clears state and redirects to login */
let onUnauthorized: (() => void) | null = null

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn
}

/**
 * Build a useful error string from an XRPC/BFF error body. Prefer the
 * human-readable `message` (e.g. "No invite code provided"), and append the
 * terse error name (e.g. "InvalidRequest") as context when both are present —
 * otherwise the UI would show only the opaque name and hide the real cause.
 */
function formatApiError(data: any, status: number, fallback: string): string {
  const message = typeof data?.message === 'string' ? data.message : ''
  const error = typeof data?.error === 'string' ? data.error : ''
  if (message && error && message !== error) return `${message} (${error})`
  return message || error || `${fallback} (${status})`
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
    throw new Error(formatApiError(data, res.status, 'Request failed'))
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

/**
 * Resolve a DID-or-handle to a DID, so fields can accept either. A value that
 * already looks like a DID is returned as-is; a handle is resolved server-side.
 */
export const resolveIdentifier = (identifier: string) =>
  request<{ did: string; handle: string | null }>(
    `/resolve?identifier=${encodeURIComponent(identifier.trim())}`,
  )

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

// --- API keys ---
// Management (create / list / delete) is owner-authed, so it goes through the
// normal atproto-proxy BFF route like any other group XRPC method.

export interface CreatedApiKey {
  keyRef: string
  key: string // plaintext — returned only once
  scopes: string[]
  createdAt: string
}

export interface ApiKeySummary {
  keyRef: string
  name: string
  scopes: string[]
  createdBy: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export const createApiKey = (groupDid: string, name: string, scopes: string[]) =>
  proxyPost('app.certified.group.keys.create', { groupDid, repo: groupDid, name, scopes }) as Promise<CreatedApiKey>

export const listApiKeys = (groupDid: string, includeRevoked = false) =>
  proxyGet('app.certified.group.keys.list', {
    groupDid,
    repo: groupDid,
    ...(includeRevoked ? { includeRevoked: 'true' } : {}),
  }) as Promise<{ keys: ApiKeySummary[]; cursor?: string }>

export const deleteApiKey = (groupDid: string, keyRef: string) =>
  proxyPost('app.certified.group.keys.delete', { groupDid, repo: groupDid, keyRef }) as Promise<{
    keyRef: string
    revokedAt: string
  }>

// Using a key authenticates via X-API-Key (no owner session / proxy). The BFF
// makes the direct call so the secret never leaves the server unnecessarily and
// CORS/cross-origin is avoided. `repo` rides the querystring (required on the
// key path, even for write procedures).
export const callWithApiKey = (args: {
  key: string
  nsid: string
  repo: string
  method?: 'GET' | 'POST'
  body?: Record<string, any>
}) =>
  request<{ status: number; data: any }>('/keys/call', {
    method: 'POST',
    body: JSON.stringify(args),
  })

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
    throw new Error(formatApiError(data, res.status, 'Upload failed'))
  }
  return data
}
