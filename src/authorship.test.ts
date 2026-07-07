import { describe, it, expect } from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  AUTHORSHIP_COLLECTION,
  authorshipRkey,
  authorshipUri,
  buildAuthorshipRecord,
  assertNotAuthorshipCollection,
} from './authorship.js'

describe('authorshipRkey', () => {
  it('composes <collection>:<rkey>', () => {
    expect(authorshipRkey('app.bsky.feed.post', '3abc123')).toBe('app.bsky.feed.post:3abc123')
  })

  it('is deterministic', () => {
    expect(authorshipRkey('app.bsky.feed.post', 'x')).toBe(
      authorshipRkey('app.bsky.feed.post', 'x'),
    )
  })

  it('stays within the 512-char rkey limit via sha256 fallback', () => {
    const longRkey = 'r'.repeat(500)
    const composed = authorshipRkey('app.bsky.feed.post', longRkey)
    expect(composed.length).toBeLessThanOrEqual(512)
    // sha256 hex — still a valid rkey charset
    expect(composed).toMatch(/^[a-f0-9]{64}$/)
    // and still deterministic
    expect(authorshipRkey('app.bsky.feed.post', longRkey)).toBe(composed)
  })

  it('only uses rkey-legal characters', () => {
    expect(authorshipRkey('app.bsky.actor.profile', 'self')).toMatch(/^[A-Za-z0-9._:~-]+$/)
  })
})

describe('authorshipUri', () => {
  it('points at the sidecar in the group repo', () => {
    expect(authorshipUri('did:plc:group1', 'app.bsky.feed.post', '3abc')).toBe(
      `at://did:plc:group1/${AUTHORSHIP_COLLECTION}/app.bsky.feed.post:3abc`,
    )
  })
})

describe('buildAuthorshipRecord', () => {
  it('builds a typed record with subject, author, createdAt', () => {
    const record = buildAuthorshipRecord({
      subject: 'at://did:plc:group1/app.bsky.feed.post/3abc',
      author: 'did:plc:member1',
    })
    expect(record.$type).toBe(AUTHORSHIP_COLLECTION)
    expect(record.subject).toBe('at://did:plc:group1/app.bsky.feed.post/3abc')
    expect(record.author).toBe('did:plc:member1')
    expect(Date.parse(record.createdAt)).not.toBeNaN()
    expect('via' in record).toBe(false)
  })

  it('includes via when supplied (API-key writes)', () => {
    const record = buildAuthorshipRecord({
      subject: 'at://did:plc:group1/app.bsky.feed.post/3abc',
      author: 'did:plc:member1',
      via: 'cgsk_ref1',
    })
    expect(record.via).toBe('cgsk_ref1')
  })

  it('preserves an explicit createdAt (backfill path)', () => {
    const record = buildAuthorshipRecord({
      subject: 'at://did:plc:group1/app.bsky.feed.post/3abc',
      author: 'did:plc:member1',
      createdAt: '2025-06-01T00:00:00.000Z',
    })
    expect(record.createdAt).toBe('2025-06-01T00:00:00.000Z')
  })
})

describe('assertNotAuthorshipCollection', () => {
  it('rejects the service-managed collection', () => {
    expect(() => assertNotAuthorshipCollection(AUTHORSHIP_COLLECTION)).toThrow(InvalidRequestError)
  })

  it('passes any other collection', () => {
    expect(() => assertNotAuthorshipCollection('app.bsky.feed.post')).not.toThrow()
    expect(() => assertNotAuthorshipCollection('app.certified.group.authorship2')).not.toThrow()
  })
})
