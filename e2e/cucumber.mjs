// Config for the cucumber-js e2e runner. The suite runs against an
// already-running CGS (local `pnpm dev` or a Railway preview); it does not
// start services. Invoke via `pnpm test:e2e` (optionally with --tags @health
// for a credential-free liveness check).
//
// Tag handling:
//   - @manual / @pending are hard-EXCLUDED (never selected) — they are not part
//     of a normal run by design.
//   - @needs-rbac-accounts / @needs-cgs-admin are credential-gated but NOT
//     tag-excluded: they are always SELECTED, and a Before hook
//     (e2e/support/hooks.ts) marks them `skipped` when their credential is
//     absent. That way they appear in the report's skipped count with a reason,
//     instead of silently vanishing from a tag filter.
//
// The importer and owner accounts are required config — a real run always has
// them — so import/records/reporting are not gated. Only the @health feature
// works with just E2E_CGS_URL.
import { config } from 'dotenv'
import { resolve } from 'node:path'

// Load e2e/.env here too: this config is evaluated before any step/support file
// (and thus before env.ts runs dotenv). CI passes the vars via the environment,
// where this is a no-op.
config({ path: resolve('e2e/.env') })

const rbacAccountsConfigured = Boolean(
  process.env.E2E_GROUP_ADMIN_IDENTIFIER &&
  process.env.E2E_GROUP_ADMIN_PASSWORD &&
  process.env.E2E_GROUP_MEMBER_IDENTIFIER &&
  process.env.E2E_GROUP_MEMBER_PASSWORD &&
  process.env.E2E_GROUP_OUTSIDER_IDENTIFIER &&
  process.env.E2E_GROUP_OUTSIDER_PASSWORD,
)
const cgsAdminConfigured = Boolean(process.env.CGS_ADMIN_PASSWORD)

// Announce which credential-gated features will be SKIPPED this run (and why),
// so the console makes coverage gaps obvious up front. The scenarios still
// appear — and are counted as skipped — in the report itself (see the Before
// hooks in support/hooks.ts); this is just an early summary.
const gated = [
  {
    tag: '@needs-rbac-accounts',
    skipped: !rbacAccountsConfigured,
    reason: 'E2E_GROUP_{ADMIN,MEMBER,OUTSIDER}_{IDENTIFIER,PASSWORD} not all set',
  },
  { tag: '@needs-cgs-admin', skipped: !cgsAdminConfigured, reason: 'CGS_ADMIN_PASSWORD not set' },
]
const skipping = gated.filter((g) => g.skipped)
if (skipping.length > 0) {
  const lines = skipping.map((g) => `  - ${g.tag}: will be SKIPPED (${g.reason})`).join('\n')
  console.warn(`[e2e] Credential-gated features skipped this run:\n${lines}`)
} else {
  console.warn('[e2e] All credential-gated features are enabled for this run.')
}

const shared = {
  paths: ['features/**/*.feature'],
  import: ['e2e/step-definitions/**/*.ts', 'e2e/support/**/*.ts'],
  strict: true,
}

export default {
  ...shared,
  format: ['pretty', 'html:reports/e2e.html', 'junit:reports/e2e.junit.xml'],
  // Only @manual/@pending are excluded from selection; credential-gated features
  // are selected and skipped at runtime so they show in the report.
  tags: 'not @manual and not @pending',
}
