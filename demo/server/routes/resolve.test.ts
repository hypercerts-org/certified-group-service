import { describe, it, expect } from 'vitest'
import { didDocumentUrl } from './resolve.js'

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
})
