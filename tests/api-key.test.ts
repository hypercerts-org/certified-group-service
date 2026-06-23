import { describe, it, expect } from 'vitest'
import {
  API_KEY_PREFIX,
  generateApiKey,
  formatApiKey,
  parseApiKey,
  hashSecret,
  verifySecret,
} from '../src/auth/api-key.js'

describe('generateApiKey', () => {
  it('produces a cgsk_<keyRef>.<secret> plaintext that round-trips through parse', () => {
    const key = generateApiKey()
    expect(key.plaintext.startsWith(`${API_KEY_PREFIX}_`)).toBe(true)

    const parsed = parseApiKey(key.plaintext)
    expect(parsed).not.toBeNull()
    expect(parsed?.keyRef).toBe(key.keyRef)
    expect(parsed?.secret).toBe(key.secret)
  })

  it('stores hash = sha256(secret), never the plaintext secret', () => {
    const key = generateApiKey()
    expect(key.hash).toBe(hashSecret(key.secret))
    expect(key.hash).not.toContain(key.secret)
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates a high-entropy secret (>= 256 bits => >= 43 base64url chars)', () => {
    const key = generateApiKey()
    expect(key.secret.length).toBeGreaterThanOrEqual(43)
  })

  it('produces distinct keyRefs and secrets across calls', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.keyRef).not.toBe(b.keyRef)
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('formatApiKey', () => {
  it('joins ref and secret with the prefix and single dot', () => {
    expect(formatApiKey('abc', 'xyz')).toBe('cgsk_abc.xyz')
  })
})

describe('parseApiKey', () => {
  it('splits a well-formed key', () => {
    expect(parseApiKey('cgsk_REF.SECRET')).toEqual({ keyRef: 'REF', secret: 'SECRET' })
  })

  it.each([
    ['', 'empty string'],
    ['REF.SECRET', 'missing prefix'],
    ['cgsk_REF', 'missing dot/secret'],
    ['cgsk_.SECRET', 'empty keyRef'],
    ['cgsk_REF.', 'empty secret'],
    ['ghp_REF.SECRET', 'wrong prefix'],
    ['cgsk_REF.SEC.RET', 'second dot ambiguous'],
  ])('returns null for malformed input (%s: %s)', (input) => {
    expect(parseApiKey(input)).toBeNull()
  })

  it('returns null for non-string input', () => {
    // @ts-expect-error exercising runtime guard
    expect(parseApiKey(undefined)).toBeNull()
    // @ts-expect-error exercising runtime guard
    expect(parseApiKey(null)).toBeNull()
  })
})

describe('verifySecret', () => {
  it('accepts the correct secret against its stored hash', () => {
    const key = generateApiKey()
    expect(verifySecret(key.secret, key.hash)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    const key = generateApiKey()
    expect(verifySecret('not-the-secret', key.hash)).toBe(false)
  })

  it('rejects when the stored hash is for a different secret', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(verifySecret(a.secret, b.hash)).toBe(false)
  })
})
