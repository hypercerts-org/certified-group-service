/**
 * Infrastructure steps shared across features: the health-check gate, account
 * resolution, the /health query, and generic response assertions.
 */
import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'node:assert'
import type { CgsWorld } from '../support/world.js'
import { resolveGroupAndOwner } from '../support/fixtures.js'
import { idResolver, resolveToDid } from '../support/cgs.js'

/**
 * Health-check the CGS with a short retry budget. A transient edge/DNS blip on
 * the first scenario should not fail the whole run; a real outage still surfaces
 * once the budget (6 x 2s fetch + 2s backoff ≈ 24s) is spent.
 */
Given('the CGS environment is running', async function (this: CgsWorld) {
  const url = `${this.env.cgsUrl}/health`
  const maxAttempts = 6
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
      lastErr = new Error(`health check failed: ${res.status} at ${url}`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error(
    `CGS health check failed after ${maxAttempts} attempts at ${url}: ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
})

/** Resolve the group/owner (always) and the RBAC role DIDs (when configured). */
Given('the test accounts are resolved', async function (this: CgsWorld) {
  // These are optional at module load so a `--tags @health` run works with only
  // E2E_CGS_URL; every non-health feature reaches this Given, so validate here.
  for (const [name, value] of [
    ['E2E_GROUP_IMPORTER_IDENTIFIER', this.env.importerIdentifier],
    ['E2E_GROUP_OWNER_IDENTIFIER', this.env.ownerIdentifier],
  ] as const) {
    if (!value) {
      throw new Error(
        `E2E configuration error: ${name} is not set.\n` +
          `Copy e2e/.env.example to e2e/.env and fill in the account credentials.`,
      )
    }
  }

  const { groupDid, groupHandle, ownerDid } = await resolveGroupAndOwner()
  this.groupDid = groupDid
  this.groupHandle = groupHandle
  this.ownerDid = ownerDid

  if (this.env.adminIdentifier) {
    this.adminDid = await resolveToDid(idResolver, this.env.adminIdentifier)
  }
  if (this.env.memberIdentifier) {
    this.memberDid = await resolveToDid(idResolver, this.env.memberIdentifier)
  }
  if (this.env.outsiderIdentifier) {
    this.outsiderDid = await resolveToDid(idResolver, this.env.outsiderIdentifier)
  }
})

// Cucumber Expressions treat `/` as an alternation separator; the {string}
// parameter takes the quoted path verbatim, so "/health" and "/xrpc/_health"
// both flow through this one step.
When('the CGS {string} endpoint is queried', async function (this: CgsWorld, path: string) {
  const res = await fetch(`${this.env.cgsUrl}${path}`)
  this.lastHttpStatus = res.status
  // Record the raw body and parse defensively so a non-JSON error response
  // (e.g. an HTML 502 from an edge) doesn't throw, and assertion failures can
  // include lastHttpBody.
  this.lastHttpBody = await res.text()
  try {
    this.lastHttpJson = JSON.parse(this.lastHttpBody) as Record<string, unknown>
  } catch {
    this.lastHttpJson = undefined
  }
})

Then('the response status is {int}', function (this: CgsWorld, expected: number) {
  assert.equal(
    this.lastHttpStatus,
    expected,
    `expected HTTP ${expected}, got ${this.lastHttpStatus}: ${this.lastHttpBody}`,
  )
})

Then('the response status field is {string}', function (this: CgsWorld, expected: string) {
  const status = (this.lastHttpJson as { status?: string } | undefined)?.status
  assert.equal(status, expected, `expected status field "${expected}", got "${status}"`)
})

Then(
  'the response {string} field is {string}',
  function (this: CgsWorld, field: string, expected: string) {
    const actual = this.lastHttpJson?.[field]
    assert.equal(
      actual,
      expected,
      `expected ${field} field "${expected}", got "${String(actual)}" (${this.lastHttpBody})`,
    )
  },
)

Then('the response contains a version string', function (this: CgsWorld) {
  const version = (this.lastHttpJson as { version?: unknown } | undefined)?.version
  assert.equal(
    typeof version,
    'string',
    `expected a version string, got ${String(version)} (${this.lastHttpBody})`,
  )
  assert.ok(
    (version as string).length > 0,
    `expected a non-empty version string (${this.lastHttpBody})`,
  )
})

Then('the response error is {string}', function (this: CgsWorld, expected: string) {
  const error = (this.lastHttpJson as { error?: string } | undefined)?.error
  assert.equal(
    error,
    expected,
    `expected error "${expected}", got "${error}" (${this.lastHttpBody})`,
  )
})

Then('the response contains a record URI', function (this: CgsWorld) {
  const uri = (this.lastHttpJson as { uri?: string } | undefined)?.uri
  assert.ok(uri && uri.startsWith('at://'), `expected an at:// record URI, got "${uri}"`)
})
