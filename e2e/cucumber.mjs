// Config for the cucumber-js e2e runner. The suite runs against an
// already-running CGS (local `pnpm dev` or a Railway preview); it does not
// start services. Invoke via `pnpm test:e2e` (optionally with --tags @health
// for a credential-free liveness check).
//
// Tag exclusions are env-driven so the suite degrades cleanly:
//   - @manual / @pending are never run by default.
//   - @needs-rbac-accounts (the multi-role authorization feature) runs only
//     when the full admin/member/outsider account set is configured.
//
// The importer and owner accounts are required config — a real run always has
// them — so import/records/reporting are not tag-gated. Only the @health
// feature works with just CGS_URL.
import { config } from 'dotenv'
import { resolve } from 'node:path'

// Load e2e/.env here too: this config is evaluated before any step/support file
// (and thus before env.ts runs dotenv), so without this the RBAC vars from a
// local .env wouldn't be visible yet and @needs-rbac-accounts would be wrongly
// excluded. CI passes the vars via the environment, where this is a no-op.
config({ path: resolve('e2e/.env') })

const rbacAccountsConfigured = Boolean(
  process.env.ADMIN_IDENTIFIER &&
  process.env.ADMIN_PASSWORD &&
  process.env.MEMBER_IDENTIFIER &&
  process.env.MEMBER_PASSWORD &&
  process.env.OUTSIDER_IDENTIFIER &&
  process.env.OUTSIDER_PASSWORD,
)

const tagExclusions = [
  'not @manual',
  'not @pending',
  ...(rbacAccountsConfigured ? [] : ['not @needs-rbac-accounts']),
]

const shared = {
  paths: ['features/**/*.feature'],
  import: ['e2e/step-definitions/**/*.ts', 'e2e/support/**/*.ts'],
  strict: true,
}

export default {
  ...shared,
  format: ['pretty', 'html:reports/e2e.html', 'junit:reports/e2e.junit.xml'],
  tags: tagExclusions.join(' and '),
}
