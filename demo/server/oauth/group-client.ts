/**
 * Direct group service client. Fetches a service auth JWT from the user's PDS,
 * then calls the group service with it.
 */
import type { Request } from 'express'
import { fetchServiceAuth, ServiceAuthError } from './service-auth.js'
import type { SessionData } from '../session.js'

export const GROUP_SERVICE_URL = process.env.GROUP_SERVICE_URL || 'http://localhost:3000'

export class GroupServiceError extends Error {
  constructor(
    message: string,
    public status: number,
    public errorName?: string,
  ) {
    super(message)
    this.name = 'GroupServiceError'
  }
}

export function isSessionExpiredError(err: unknown): boolean {
  if (err instanceof ServiceAuthError && err.status === 401) return true
  if (err instanceof Error && err.message?.includes('log in again')) return true
  return false
}

interface CallOptions {
  session: SessionData
  groupDid: string
  nsid: string
  method: 'GET' | 'POST'
  params?: Record<string, string>
  body?: unknown
  contentType?: string
  rawBody?: Uint8Array
  req?: Request
}

export async function callGroupService(opts: CallOptions): Promise<{ status: number; data: unknown }> {
  const { session, groupDid, nsid, method, params, body, contentType, rawBody, req } = opts

  // Step 1: get service auth JWT from PDS
  const jwt = await fetchServiceAuth(session, groupDid, nsid, req)

  // Step 2: build group service URL
  const url = new URL(`/xrpc/${nsid}`, GROUP_SERVICE_URL)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

  // Step 3: call group service
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
  }

  let fetchBody: BodyInit | undefined
  if (method === 'POST') {
    if (rawBody) {
      headers['Content-Type'] = contentType || 'application/octet-stream'
      fetchBody = rawBody
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      fetchBody = JSON.stringify(body)
    }
  }

  const res = await fetch(url, { method, headers, body: fetchBody })

  // Step 4: parse response
  const resContentType = res.headers.get('content-type') || ''
  let data: unknown

  if (resContentType.includes('application/json')) {
    data = await res.json()
  } else {
    data = await res.text()
  }

  if (!res.ok) {
    const parsed = typeof data === 'object' && data !== null ? data as { error?: string; message?: string } : null
    throw new GroupServiceError(
      parsed?.message || parsed?.error || String(data) || `Group service error (${res.status})`,
      res.status,
      parsed?.error,
    )
  }

  return { status: res.status, data }
}
