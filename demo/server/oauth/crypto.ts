import * as crypto from 'node:crypto'

// PKCE
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// DPoP key pair — generate once per OAuth flow, never reuse across flows
export function generateDpopKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  return {
    privateKey,
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  }
}

// Restore a DPoP key pair from a serialized private JWK (e.g. from session)
export function restoreDpopKeyPair(privateJwk: crypto.JsonWebKey) {
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' })
  const publicKey = crypto.createPublicKey(privateKey)
  return { privateKey, publicJwk: publicKey.export({ format: 'jwk' }) }
}

// Create a DPoP proof JWT
export function createDpopProof(opts: {
  privateKey: crypto.KeyObject
  jwk: object
  method: string
  url: string
  nonce?: string
  accessToken?: string
}): string {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: opts.jwk }
  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: opts.method,
    htu: opts.url,
    iat: Math.floor(Date.now() / 1000),
  }
  if (opts.nonce) payload.nonce = opts.nonce
  if (opts.accessToken) {
    payload.ath = crypto
      .createHash('sha256')
      .update(opts.accessToken)
      .digest('base64url')
  }

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = crypto.sign('sha256', Buffer.from(signingInput), opts.privateKey)
  return `${signingInput}.${derToRaw(sig).toString('base64url')}`
}

// Convert DER-encoded ECDSA signature to raw r||s (required for ES256 JWTs)
function derToRaw(der: Buffer): Buffer {
  let offset = 2
  if (der[1]! > 0x80) offset += der[1]! - 0x80
  offset++ // skip 0x02
  const rLen = der[offset++]!
  let r = der.subarray(offset, offset + rLen)
  offset += rLen
  offset++ // skip 0x02
  const sLen = der[offset++]!
  let s = der.subarray(offset, offset + sLen)
  if (r.length > 32) r = r.subarray(r.length - 32)
  if (s.length > 32) s = s.subarray(s.length - 32)
  const raw = Buffer.alloc(64)
  r.copy(raw, 32 - r.length)
  s.copy(raw, 64 - s.length)
  return raw
}
