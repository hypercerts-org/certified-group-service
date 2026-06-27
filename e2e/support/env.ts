/**
 * Loads and validates the e2e configuration from e2e/.env (separate from the
 * repo-root .env, which holds real service config). Mirrors the ePDS pattern: a
 * throwing `required()` (never process.exit, which would kill the cucumber
 * runner mid-suite) and a typed `testEnv` export.
 *
 * The PDS accounts the suite uses (importer, owner, and the per-role RBAC
 * accounts) are provisioned up front — the suite never creates them. Only
 * E2E_CGS_URL is needed to run the @health feature alone; everything else needs the
 * importer/owner credentials, and the RBAC feature additionally needs the
 * admin/member/outsider account set.
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve('e2e/.env') })

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `E2E configuration error: ${name} is not set.\n` +
        `Copy e2e/.env.example to e2e/.env and fill in the required values.`,
    )
  }
  return value
}

const cgsUrl = required('E2E_CGS_URL').replace(/\/$/, '')

// Validate the URL up front so an invalid E2E_CGS_URL fails with a clear message
// rather than a bare TypeError from the URL constructor below.
let cgsHostname: string
try {
  cgsHostname = new URL(cgsUrl).hostname
} catch {
  throw new Error(
    `E2E configuration error: E2E_CGS_URL="${cgsUrl}" is not a valid URL.\n` +
      `Provide a complete URL like https://example.com`,
  )
}

export const testEnv = {
  cgsUrl,
  // Service-level aud (import/register). The script default mirrors the smoke
  // scripts: did:web:<E2E_CGS_URL host>. Override only if the deployment's
  // SERVICE_URL points somewhere other than its own host.
  serviceDid: process.env.E2E_CGS_SERVICE_DID || `did:web:${cgsHostname}`,

  // Importer: the pre-provisioned account promoted to a group (= groupDid). It
  // signs the import JWT (iss === groupDid). Optional at load time so a
  // credential-free `--tags @health` run works with only E2E_CGS_URL; the steps
  // that need it (the "test accounts are resolved" Given) validate it.
  importerIdentifier: process.env.E2E_GROUP_IMPORTER_IDENTIFIER ?? '',
  importerPassword: process.env.E2E_GROUP_IMPORTER_PASSWORD ?? '',
  importerAppPassword: process.env.E2E_GROUP_IMPORTER_APP_PASSWORD ?? '',

  // Owner: the DID seeded as the group's RBAC owner. Commonly the same account
  // as the importer. Optional at load time for the same reason as the importer.
  ownerIdentifier: process.env.E2E_GROUP_OWNER_IDENTIFIER ?? '',
  ownerPassword: process.env.E2E_GROUP_OWNER_PASSWORD ?? '',

  // RBAC accounts: distinct pre-provisioned accounts with passwords so each can
  // sign its own JWTs for positive/negative authorization tests.
  adminIdentifier: process.env.E2E_GROUP_ADMIN_IDENTIFIER ?? '',
  adminPassword: process.env.E2E_GROUP_ADMIN_PASSWORD ?? '',
  memberIdentifier: process.env.E2E_GROUP_MEMBER_IDENTIFIER ?? '',
  memberPassword: process.env.E2E_GROUP_MEMBER_PASSWORD ?? '',
  outsiderIdentifier: process.env.E2E_GROUP_OUTSIDER_IDENTIFIER ?? '',
  outsiderPassword: process.env.E2E_GROUP_OUTSIDER_PASSWORD ?? '',

  // Label for the app password the helper mints on the importer account.
  appPasswordName: process.env.E2E_GROUP_IMPORTER_APP_PASSWORD_NAME ?? 'cgs-e2e-smoke',

  // The CGS *service* admin password — the HTTP Basic credential for the
  // operator-only app.certified.group.admin.* endpoints. This is the real
  // CGS_ADMIN_PASSWORD set on the CGS deployment itself (a service-wide
  // credential, not e2e-only — hence no E2E_ prefix), as opposed to the
  // per-test-group role accounts above (E2E_GROUP_*).
  cgsAdminPassword: process.env.CGS_ADMIN_PASSWORD ?? '',
}

/** True when the full RBAC account set is configured (all six vars). */
export const rbacAccountsConfigured = Boolean(
  testEnv.adminIdentifier &&
  testEnv.adminPassword &&
  testEnv.memberIdentifier &&
  testEnv.memberPassword &&
  testEnv.outsiderIdentifier &&
  testEnv.outsiderPassword,
)

/** True when the CGS service admin password is configured (admin endpoints enabled). */
export const cgsAdminConfigured = Boolean(testEnv.cgsAdminPassword)
