import { describe, it, expect } from 'vitest'
import { didDocumentUrl, isPublicHost } from './resolve.js'

// didDocumentUrl maps a DID to where its document lives — the most error-prone
// part of reverse handle resolution (did:web path/host encoding). Network
// fetching and alsoKnownAs parsing are covered end-to-end by the live browser
// test; these assert the URL construction that a unit test can pin down.
describe('didDocumentUrl', () => {
  it('maps a did:plc to the PLC directory', () => {
    expect(didDocumentUrl('did:plc:qvay7faxuyobqaftqfltlvhf')).toBe(
      'https://plc.directory/did%3Aplc%3Aqvay7faxuyobqaftqfltlvhf',
    )
  })

  it('maps a bare did:web to the host well-known document', () => {
    expect(didDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json')
  })

  it('maps a did:web with a path (colon-separated segments)', () => {
    expect(didDocumentUrl('did:web:example.com:user:alice')).toBe(
      'https://example.com/user/alice/.well-known/did.json',
    )
  })

  it('returns null for an unsupported DID method', () => {
    expect(didDocumentUrl('did:key:z6Mk')).toBeNull()
    expect(didDocumentUrl('not-a-did')).toBeNull()
  })

  it('returns null for a did:web pointing at a non-public host (SSRF guard)', () => {
    expect(didDocumentUrl('did:web:localhost')).toBeNull()
    expect(didDocumentUrl('did:web:127.0.0.1')).toBeNull()
    expect(didDocumentUrl('did:web:10.0.0.5')).toBeNull()
  })

  it('returns null for a did:web with malformed percent-encoding', () => {
    expect(didDocumentUrl('did:web:%ZZ')).toBeNull()
  })
})

describe('isPublicHost', () => {
  it('accepts public dotted hostnames', () => {
    expect(isPublicHost('example.com')).toBe(true)
    expect(isPublicHost('epds1.test.certified.app')).toBe(true)
  })

  it('rejects loopback, private, link-local and internal hosts', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      'db.internal',
      'host.local',
      'nodothost',
    ]) {
      expect(isPublicHost(h), h).toBe(false)
    }
  })

  it('does not over-block public 172.x outside the private range', () => {
    expect(isPublicHost('172.15.0.1')).toBe(true)
    expect(isPublicHost('172.32.0.1')).toBe(true)
  })
})
