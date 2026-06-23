// Hypercerts collections + record templates, shared by the Records page and the
// API Keys "Use a key" box so neither ships a second, drifting copy.
//
// The collection NSIDs come straight from `@hypercerts-org/lexicon` (the
// protocol's source of truth) rather than being retyped, so a renamed or added
// collection surfaces as a type error here instead of a silent string typo.
//
// The templates are **minimal but lexicon-valid**: they carry exactly the
// fields each record's lexicon marks `required`, filled with placeholder values
// of the right shape. Optional fields (the union/ref-typed ones like
// `description`, `workScope`, `contributors`) are omitted — they are not needed
// to create a valid record and only obscure the example. `collections.test.ts`
// validates every template against the packaged lexicon, so they cannot drift
// out of compliance unnoticed.
import {
  ACTIVITY_NSID,
  CONTEXT_ATTACHMENT_NSID,
  CONTEXT_MEASUREMENT_NSID,
  CONTEXT_EVALUATION_NSID,
} from '@hypercerts-org/lexicon'

/** The hypercerts collections the demo offers as record-write targets. */
export const COLLECTIONS = [
  ACTIVITY_NSID,
  CONTEXT_ATTACHMENT_NSID,
  CONTEXT_MEASUREMENT_NSID,
  CONTEXT_EVALUATION_NSID,
] as const

export type Collection = (typeof COLLECTIONS)[number]

/**
 * Build a minimal lexicon-valid record for `collection`, stamped with `now`
 * (ISO 8601) as `createdAt`. Returns `null` for an unknown collection so a
 * custom collection falls back to a bare `$type` skeleton at the call site.
 *
 * Required fields per lexicon (verified in collections.test.ts):
 *  - claim.activity     → title, shortDescription, createdAt
 *  - context.attachment → title, createdAt
 *  - context.measurement→ metric, unit, value (numeric STRING), createdAt
 *  - context.evaluation → evaluators (array of {did}), summary, createdAt
 */
export function recordTemplate(collection: string, now: string): Record<string, unknown> | null {
  switch (collection) {
    case ACTIVITY_NSID:
      return {
        $type: ACTIVITY_NSID,
        title: '',
        shortDescription: '',
        createdAt: now,
      }
    case CONTEXT_ATTACHMENT_NSID:
      return {
        $type: CONTEXT_ATTACHMENT_NSID,
        title: '',
        createdAt: now,
      }
    case CONTEXT_MEASUREMENT_NSID:
      return {
        $type: CONTEXT_MEASUREMENT_NSID,
        metric: '',
        unit: '',
        // `value` is a numeric STRING in the lexicon (e.g. "1234.56"), not a number.
        value: '0',
        createdAt: now,
      }
    case CONTEXT_EVALUATION_NSID:
      return {
        $type: CONTEXT_EVALUATION_NSID,
        // Each evaluator is an `app.certified.defs#did` object whose `did` must
        // pass the lexicon's `did` format check — so the placeholder is a valid
        // DID for the user to replace, not an empty string (which fails format).
        evaluators: [{ did: 'did:web:example.com' }],
        summary: '',
        createdAt: now,
      }
    default:
      return null
  }
}

/** The JSON string a custom (non-hypercerts) collection starts from. */
export function customTemplate(collection: string, now: string): Record<string, unknown> {
  return { $type: collection, createdAt: now }
}
