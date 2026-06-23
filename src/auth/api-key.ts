import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * API-key format: `cgsk_<keyRef>.<secret>`
 *
 * - `cgsk` — fixed prefix (Certified Group Service Key), so leaked keys are
 *   recognisable and scannable (cf. GitHub `ghp_`).
 * - `<keyRef>` — short, non-secret per-key id; the `group_api_keys` primary key.
 *   Identifies *which* key within an already-located group DB. Carries no group
 *   identifier — the group is named by the request, never by the key.
 * - `<secret>` — high-entropy random (256 bits, base64url). Only its SHA-256
 *   hash is stored server-side; the plaintext is returned once at creation.
 */
export const API_KEY_PREFIX = 'cgsk'

const KEY_REF_BYTES = 9 // 72 bits -> 12 base64url chars; collision-resistant, non-secret
const SECRET_BYTES = 32 // 256 bits

export interface GeneratedApiKey {
  /** Non-secret per-key id; stored as the `group_api_keys` primary key. */
  keyRef: string
  /** Plaintext secret — returned to the caller once, never stored. */
  secret: string
  /** Full `cgsk_<keyRef>.<secret>` string handed to the caller once. */
  plaintext: string
  /** SHA-256(secret) hex — the only secret-derived value stored at rest. */
  hash: string
}

export interface ParsedApiKey {
  keyRef: string
  secret: string
}

/** Mint a fresh API key: random keyRef + secret, plus the stored hash. */
export function generateApiKey(): GeneratedApiKey {
  const keyRef = randomBytes(KEY_REF_BYTES).toString('base64url')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    keyRef,
    secret,
    plaintext: formatApiKey(keyRef, secret),
    hash: hashSecret(secret),
  }
}

/** Assemble the wire form `cgsk_<keyRef>.<secret>`. */
export function formatApiKey(keyRef: string, secret: string): string {
  return `${API_KEY_PREFIX}_${keyRef}.${secret}`
}

/**
 * Parse a key string into its parts, or return null if it is malformed.
 *
 * Requires the exact `cgsk_<keyRef>.<secret>` shape with non-empty parts. The
 * split is unambiguous even though base64url uses `-` and `_`: the prefix is
 * split on the FIRST `_` (and the fixed `cgsk` prefix contains none), and the
 * keyRef/secret on the FIRST `.` (base64url contains no `.`). So a `_` inside
 * the keyRef or secret is harmless — only the leading `cgsk_` boundary and the
 * single separating `.` are structural.
 */
export function parseApiKey(input: string): ParsedApiKey | null {
  if (typeof input !== 'string') return null

  const underscore = input.indexOf('_')
  if (underscore === -1) return null
  if (input.slice(0, underscore) !== API_KEY_PREFIX) return null

  const rest = input.slice(underscore + 1)
  const dot = rest.indexOf('.')
  if (dot === -1) return null

  const keyRef = rest.slice(0, dot)
  const secret = rest.slice(dot + 1)
  if (keyRef.length === 0 || secret.length === 0) return null
  // Reject anything with a second separator — keeps the format unambiguous.
  if (secret.includes('.')) return null

  return { keyRef, secret }
}

/** SHA-256 of the secret, hex-encoded. The stored `key_hash`. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * Constant-time comparison of a presented secret against a stored hash.
 * Hashes the presented secret first so both operands are fixed-length hex,
 * avoiding the length-leak that comparing raw secrets would risk.
 */
export function verifySecret(presentedSecret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(presentedSecret), 'utf8')
  const stored = Buffer.from(storedHash, 'utf8')
  if (presented.length !== stored.length) return false
  return timingSafeEqual(presented, stored)
}
