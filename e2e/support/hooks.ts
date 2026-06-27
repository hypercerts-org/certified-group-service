/**
 * Suite hooks. Lightweight (no browser): a generous default timeout for
 * Railway cold-start + PDS login + DID resolution, the import/destroy lifecycle
 * bookends, and a per-scenario failure artifact.
 */
import { BeforeAll, AfterAll, Before, After, Status, setDefaultTimeout } from '@cucumber/cucumber'
import { mkdir, appendFile } from 'node:fs/promises'
import type { CgsWorld } from './world.js'
import { ensureGroupImported, teardownGroup } from './fixtures.js'
import { rbacAccountsConfigured, cgsAdminConfigured } from './env.js'

setDefaultTimeout(60_000)

// Credential-gated features are SELECTED (not tag-excluded), so they always
// appear in the report. These Before hooks mark them `skipped` when their
// credential set is absent — rather than letting a tag filter make them vanish
// silently — so the report's skipped count reflects what was not covered.
// Returning 'skipped' from a Before hook tells cucumber to skip the scenario.
Before({ tags: '@needs-rbac-accounts' }, function () {
  if (!rbacAccountsConfigured) return 'skipped'
})

Before({ tags: '@needs-cgs-admin' }, function () {
  if (!cgsAdminConfigured) return 'skipped'
})

BeforeAll(async function () {
  await mkdir('reports', { recursive: true })
  // Import the shared test group so the group-scoped features have a live group.
  // No-ops when importer credentials aren't configured (only @health runs then).
  await ensureGroupImported()
})

AfterAll(async function () {
  // Always runs, even on failure — leaves a clean slate for the next run.
  await teardownGroup()
})

After(async function (this: CgsWorld, scenario) {
  if (scenario.result?.status === Status.FAILED) {
    const line =
      `\n[FAILED] ${scenario.pickle.name}\n` +
      `  status=${this.lastHttpStatus ?? '(none)'}\n` +
      `  body=${this.lastHttpBody ?? '(none)'}\n`
    await appendFile('reports/e2e-failures.log', line).catch(() => {})
  }
})
