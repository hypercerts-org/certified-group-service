# E2E tests

End-to-end tests for the group service (CGS) using
[Cucumber.js](https://cucumber.io/). Unlike the unit suite (`pnpm test`,
vitest), these drive a **real running CGS** the way a client would: real atproto
service-auth JWTs, a real PDS, real per-group databases.

CGS is a pure XRPC HTTP API, so — unlike the sibling ePDS suite — there is **no
browser and no Playwright**. Every step is a `fetch()` to `/xrpc/*` or `/health`.

The `.feature` files live in `features/` at the repo root; step definitions and
support code live here in `e2e/`.

See [`docs/design/e2e-tests.md`](../docs/design/e2e-tests.md) for the full design.

## Prerequisites

- Node.js >= 20 and pnpm
- A running CGS to test against (local `pnpm dev` or a deployed preview)
- Pre-provisioned PDS test accounts (see below) — the suite **never creates PDS
  accounts**; it tests CGS functionality, not account provisioning.

## Setup

```bash
cp e2e/.env.example e2e/.env
```

Fill in `e2e/.env`. Every variable that exists only for the e2e suite is
prefixed `E2E_` (`E2E_GROUP_` for the per-test-group accounts), so it can't be
confused with a real service-deployment variable. In the common case the
importer and owner are the same account. To produce
`E2E_GROUP_IMPORTER_APP_PASSWORD`:

```bash
pnpm e2e:app-password
```

(Copy the printed value into `E2E_GROUP_IMPORTER_APP_PASSWORD`.)

## Running

```bash
# Full suite against the configured E2E_CGS_URL
pnpm test:e2e

# Liveness only — no credentials needed beyond E2E_CGS_URL
pnpm test:e2e --tags @health

# A single feature
pnpm test:e2e features/records.feature
```

Reports are written to `reports/` (HTML at `reports/e2e.html`, JUnit XML, and a
`reports/e2e-failures.log` with the last HTTP response for any failed scenario).

## The accounts

The suite tests CGS, not PDS-account creation, so every account is provisioned
up front and supplied via env:

| Role     | Vars                                                            | Used for                                       |
| -------- | --------------------------------------------------------------- | ---------------------------------------------- |
| importer | `E2E_GROUP_IMPORTER_IDENTIFIER` / `_PASSWORD` / `_APP_PASSWORD` | the account promoted to a group (= groupDid)   |
| owner    | `E2E_GROUP_OWNER_IDENTIFIER` / `_PASSWORD`                      | the RBAC owner (commonly == importer)          |
| admin    | `E2E_GROUP_ADMIN_IDENTIFIER` / `_PASSWORD`                      | seeded as admin for the RBAC feature           |
| member   | `E2E_GROUP_MEMBER_IDENTIFIER` / `_PASSWORD`                     | seeded as member for the RBAC feature          |
| outsider | `E2E_GROUP_OUTSIDER_IDENTIFIER` / `_PASSWORD`                   | a non-member, for negative authorization tests |

Only `E2E_CGS_URL` is needed to run `--tags @health`. The RBAC feature
(`@needs-rbac-accounts`) is skipped unless the full admin/member/outsider set is
configured.

The admin-set-owner feature (`@needs-cgs-admin`) additionally needs
`CGS_ADMIN_PASSWORD` — the **service** admin password set on the CGS deployment
under test (a real deployment credential, hence no `E2E_` prefix), used for the
HTTP Basic auth on `app.certified.group.admin.*`.

## The auth model

Every XRPC method needs an atproto service-auth JWT. The suite mints these by
logging into the caller's PDS with a password and calling `getServiceAuth` — a
**smoke-test convenience**; real clients use OAuth (see
[`docs/integration-guide.md`](../docs/integration-guide.md)). Service-level
methods (`group.import`, `group.register`) use `aud = the service DID`;
group-scoped methods use `aud = the group DID` (the group must already exist).
Tokens are single-use and short-lived (≤120s), so each call mints a fresh one.

## Self-cleaning lifecycle

The suite reuses one throwaway test group: a `BeforeAll` hook imports it and an
`AfterAll` hook destroys it. The import tolerates a stale prior import
(`GroupAlreadyRegistered`) by destroying and re-importing, so the suite is
re-runnable indefinitely against the same account.

## Tags

| Tag                    | Meaning                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@health`              | Unauthenticated liveness — runs with only `E2E_CGS_URL`.                                                      |
| `@needs-rbac-accounts` | RBAC feature — skipped unless the admin/member/outsider set is set.                                           |
| `@needs-cgs-admin`     | admin-set-owner feature — skipped unless `CGS_ADMIN_PASSWORD` (+ RBAC accounts) is set.                       |
| `@manual`              | Excluded from the default run (e.g. `register`, which creates a PDS account that can't be cleanly torn down). |
| `@pending`             | Excluded from the default run.                                                                                |

## CI

`.github/workflows/e2e.yml` runs on `pull_request` (plus a post-merge backstop
on `push` to `main`, and manual `workflow_dispatch`). It mirrors the ePDS
workflow: a `gate` job skips the run unless relevant paths changed; the run job
finds the PR's Railway preview deployment, derives the CGS URL from the env name,
health-checks `/health`, then runs the suite. The account **passwords** come from
repository **secrets**; the account **identifiers** (public handles/DIDs) and
`E2E_CGS_SERVICE_DID` come from repository **variables** (`vars.*`), under their
`E2E_`-prefixed names. Populate both from a filled `e2e/.env` with
`scripts/set-e2e-secrets.sh`. `workflow_dispatch` takes an `env_name` input for
re-running against a known Railway env.
