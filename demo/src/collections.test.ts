import { describe, it, expect } from 'vitest'
import { validate } from '@hypercerts-org/lexicon'
import { COLLECTIONS, recordTemplate, customTemplate } from './collections'

// Guard against template drift: every hypercerts record template the demo
// prefills must validate against the packaged lexicon. If a lexicon adds a
// required field or changes a type, this fails until the template is updated —
// so the demo can never ship an example record that the PDS would reject for
// shape (which is exactly how the original hand-written templates rotted).
describe('recordTemplate', () => {
  const NOW = '2026-06-09T10:15:00.000Z'

  for (const collection of COLLECTIONS) {
    it(`produces a lexicon-valid record for ${collection}`, () => {
      const record = recordTemplate(collection, NOW)
      expect(record, `no template for ${collection}`).not.toBeNull()
      const result = validate(record, collection, 'main', true)
      // Surface the lexicon's own error message on failure rather than a bare
      // "expected true to be false".
      expect(result.success, result.success ? '' : String(result.error)).toBe(true)
    })
  }

  it('stamps createdAt with the supplied timestamp', () => {
    const record = recordTemplate(COLLECTIONS[0], NOW)
    expect(record?.createdAt).toBe(NOW)
  })

  it('returns null for an unknown collection', () => {
    expect(recordTemplate('com.example.unknown', NOW)).toBeNull()
  })
})

describe('customTemplate', () => {
  it('builds a bare $type skeleton for a custom collection', () => {
    expect(customTemplate('com.example.thing', '2026-01-01T00:00:00.000Z')).toEqual({
      $type: 'com.example.thing',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })
})
