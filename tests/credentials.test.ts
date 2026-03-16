import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../src/pds/credentials.js'
import { randomBytes } from 'node:crypto'

describe('credentials', () => {
  const key = randomBytes(32)

  it('round-trips encrypt/decrypt', () => {
    const plaintext = 'my-app-password-1234'
    const encrypted = encrypt(plaintext, key)
    expect(decrypt(encrypted, key)).toBe(plaintext)
  })

  it('produces different ciphertexts for same plaintext (random IV)', () => {
    const plaintext = 'same-password'
    const a = encrypt(plaintext, key)
    const b = encrypt(plaintext, key)
    expect(a).not.toBe(b)
  })

  it('throws on wrong key', () => {
    const encrypted = encrypt('secret', key)
    const wrongKey = randomBytes(32)
    expect(() => decrypt(encrypted, wrongKey)).toThrow()
  })

  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('secret', key)
    const buf = Buffer.from(encrypted, 'base64')
    buf[buf.length - 1] ^= 0xff
    const tampered = buf.toString('base64')
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('empty plaintext round-trips', () => {
    const encrypted = encrypt('', key)
    expect(decrypt(encrypted, key)).toBe('')
  })

  it('long plaintext round-trips', () => {
    const long = 'x'.repeat(10 * 1024)
    const encrypted = encrypt(long, key)
    expect(decrypt(encrypted, key)).toBe(long)
  })

  it('wrong key throws', () => {
    const encrypted = encrypt('secret', key)
    const wrongKey = randomBytes(32)
    expect(() => decrypt(encrypted, wrongKey)).toThrow()
  })
})
