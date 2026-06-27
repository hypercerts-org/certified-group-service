# Design: End-to-end tests for the group service

Status: **Draft / proposal**

Tracking issues:

- _(none yet — file a HYPER ticket for the e2e suite and link it here)_

Related prior art:

- The sibling **ePDS** repo's Cucumber.js e2e suite (`../ePDS/e2e/` +
  `../ePDS/features/`), which this design adapts.
- The existing CGS manual smoke scripts in `tests/smoke/` ([group-import
  design](group-import.md) introduced them), which this design **matures** into
  a first-class suite.

## Motivation

CGS currently has two tiers of tests:

- **vitest** (`tests/*.test.ts`) — fast, fork-isolated, in-memory SQLite, the
  PDS agent pool mocked. Great for unit/integration coverage, but it never
  exercises a real deployment, a real PDS, or real atproto service-auth.
- **manual smoke scripts** (`tests/smoke/*.ts`) — `import`, `create-record`,
  `destroy`, `create-app-password`. Each hits a **live** CGS, mints a real
  service-auth JWT, and POSTs to one XRPC method. They are excluded from vitest
  and run by hand with `tsx`. They were a quick hack to prove the import flow
  end-to-end against the PR-30 Railway preview.

The smoke scripts are valuable but ad hoc: one script per method, no shared
assertions, no reporting, no CI story, and the destroy script needs an
interactive prompt. The sibling **ePDS** repo already solved this shape with a
**Cucumber.js** suite — Gherkin `.feature` files at the repo root, step
definitions and support code under `e2e/`, run against an already-running stack
(local or Railway). This design ports that structure to CGS and broadens it past
the four smoke flows to the RBAC/member surface.

**Key difference from ePDS**: CGS is a pure XRPC HTTP API — **no browser, no
Playwright, no Mailpit**. ePDS's suite is browser-driven (OAuth consent screens,
email OTP). The CGS suite is HTTP-only: every step is a `fetch()` to `/xrpc/*`
or `/health`. The hard part is auth, not browser orchestration.

## Goals

- A repeatable, CI-runnable e2e suite that drives a **real** running CGS the way
  a real client would — real service-auth JWTs, real PDS, real per-group DBs.
- **Reuse** the smoke scripts' hard-won machinery (DID resolution, JWT minting
  via `getServiceAuth`) rather than reinventing it; keep the smoke scripts for
  manual/interactive one-offs.
- Cover the lifecycle the smoke scripts already prove (import → write → destroy)
  **plus** the RBAC/member methods (member.add/list/remove, role.set,
  audit.query, membership.list, put/deleteRecord, uploadBlob).
- **Self-cleaning**: the suite reuses the same throwaway test group account each
  run and must converge to a clean slate, even if a previous run died mid-way.

## Non-goals

- **Testing PDS-account creation.** The suite tests **CGS functionality**, not
  the provisioning of atproto accounts. **Every** account it needs — importer,
  owner, and the per-role accounts for RBAC testing (admin, member, outsider) —
  is provisioned **up front** and supplied via env; the suite never creates PDS
  accounts. This is why `group.register` (which _creates_ a brand-new PDS
  account) is `@manual` and out of the core suite, while `group.import`
  (promoting a pre-existing account) is core.
- Replacing the smoke scripts. They stay for manual use (esp. destroy's
  interactive handle confirmation and the app-password helper).
- Browser / OAuth-UI testing — CGS has no UI. Real OAuth-session minting (vs the
  password-login convenience below) is out of scope for the first cut.
- Spinning up the stack. Like ePDS, the suite runs against an **already-running**
  CGS (local `pnpm dev` or a Railway preview); it does not start services.

## Background: the auth constraint

This is what makes CGS e2e harder than ePDS e2e. Only `GET /health` is auth-free
(`src/index.ts`). Every XRPC method requires an atproto **service-auth JWT**,
validated by `AuthVerifier` (`src/auth/verifier.ts`):

- **`aud`** — for **service-level** methods (`group.register`, `group.import`)
  the audience is the **service DID** (`did:web:<host>`), checked directly. For
  **group-scoped** methods (everything else) the audience is the **group DID**;
  the verifier passes `null` to `verifyJwt` and instead looks the `aud` up in the
  `groups` table — so **the group must already be imported** or the call fails
  `Invalid audience`.
- **`lxm`** — must equal the method NSID.
- **lifetime** — `exp - iat ≤ 120s` (`NONCE_TTL_SECONDS`, hardcoded).
- **`jti`** — single-use; replay is rejected via the nonce cache. **Every call
  must mint a fresh token.**

The smoke scripts already mint compliant tokens the pragmatic way: log into the
caller's PDS with a password (`AtpAgent.login`) and call
`com.atproto.server.getServiceAuth({ aud, lxm })`. This is explicitly a
**smoke-test convenience** — real callers authenticate via OAuth and call
`getServiceAuth` over an OAuth session (see `docs/integration-guide.md`). The
e2e suite reuses this same minting approach.

## Design

### Layout (mirrors ePDS)

```text
features/                      # Gherkin .feature files at repo root
  health.feature              # no auth
  import.feature              # group.import (explicit assertions + clean-slate path)
  register.feature            # group.register — @manual (leaks a PDS account; see below)
  records.feature             # repo.createRecord/putRecord/uploadBlob/deleteRecord
  membership.feature          # RBAC across roles: member.*, role.set + positive/negative authz
  reporting.feature           # audit.query, membership.list
  admin-set-owner.feature     # admin.setOwner (HTTP Basic auth) — @needs-cgs-admin
e2e/
  cucumber.mjs                 # profiles + env-driven tag exclusions
  tsconfig.e2e.json
  .env.example
  README.md
  support/
    env.ts                     # load e2e/.env, typed testEnv
    world.ts                   # CgsWorld: HTTP + auth/DID state (no browser)
    cgs.ts                     # mintServiceAuth / callXrpc (the auth wrapper)
    fixtures.ts                # ensureGroupImported / teardownGroup (clean-slate)
    app-password.ts            # PDS helper to mint IMPORTER_APP_PASSWORD (not a test)
    hooks.ts                   # BeforeAll import / AfterAll destroy + failure artifact
  step-definitions/
    common.steps.ts            # health gate, account resolution, shared asserts
    import.steps.ts            # group.import + group.destroy assertions
    register.steps.ts          # group.register assertions (@manual)
    records.steps.ts           # repo.createRecord/putRecord/uploadBlob/deleteRecord
    members.steps.ts           # member.*, role.set, audit.query, membership.list
    admin.steps.ts             # admin.setOwner via HTTP Basic auth
```

**Admin endpoints (`admin-set-owner.feature`).** The `app.certified.group.admin.*`
namespace is operator-gated, not member-gated: it authenticates with HTTP Basic
auth against the service admin password, not a service-auth JWT. So its steps use
a dedicated `callXrpcWithBasicAuth` wrapper rather than `mintServiceAuth` /
`callXrpc`, and the feature is gated by a new `@needs-cgs-admin` tag that runs
only when `CGS_ADMIN_PASSWORD` is configured (alongside `@needs-rbac-accounts`,
since it needs the owner/admin accounts to swap between).

> **Naming.** Every e2e-only env var is `E2E_`-prefixed (`E2E_GROUP_` for the
> per-test-group accounts), so a test-group credential like
> `E2E_GROUP_ADMIN_PASSWORD` (the admin _role account's_ PDS password) can never
> be confused with a real service variable. The service admin password is the one
> exception: it is `CGS_ADMIN_PASSWORD` — a real deployment credential (the same
> var the CGS instance reads), not e2e-only, so it is **not** prefixed.

The happy-path scenario reassigns ownership to the admin account and then reverts
it, leaving the group as it started (the same non-destructive pattern the RBAC
feature uses for seeding/cleanup).

The import (clean-slate) and destroy (teardown) are also **`BeforeAll`/`AfterAll`
fixtures** so the group exists for `records`/`membership`/`reporting` without
each of those features re-importing. `import.feature` additionally asserts the
import **and** destroy methods explicitly (the fixture exercises them but makes
no assertions); see "Two roles for import/destroy" below. This decouples the
number of feature files from the lifecycle and lets us split by concern.

`.feature` files live at the repo root (ePDS convention); step defs + support
live under `e2e/`. The suite is **separate from vitest**, exactly as the smoke
tests are.

### Reuse vs re-home

- **Reuse directly** from `tests/smoke/lib.ts`: `resolveToDid` and
  `resolveAccount` (pure, throw-on-error). `e2e/support/cgs.ts` imports them
  across the `tests/` boundary; `tsconfig.e2e.json` widens `rootDir`/`include`
  to compile them together.
- **Do not import** `loadSmokeEnv`/`reqEnv` — they call `process.exit`, which
  would kill the cucumber runner on a single bad var. `e2e/support/env.ts` owns
  env loading with a **throwing** `required()` (ePDS pattern).
- **Re-home** the per-script `login + getServiceAuth + fetch` triplication into
  one `e2e/support/cgs.ts` wrapper, so steps are one-liners and there is a single
  source of truth for minting.

### `e2e/support/cgs.ts` — the auth wrapper

- `mintServiceAuth({ identifier, password, aud, lxm }) → token` — `resolveAccount`
  → `AtpAgent.login` → `getServiceAuth`. Mints a **fresh** token per call. This is
  the generic "sign as any caller" primitive: pass owner/admin/member/outsider
  creds to drive the RBAC positive/negative cases as that role.
- `callXrpc(world, { cgsUrl, nsid, token, body?, method? })` — `fetch`
  `/xrpc/<nsid>` with `Bearer`; store `status`/`json`/`body` on the World. POST
  for procedures, GET for queries (`member.list`, `audit.query`,
  `membership.list`). `Content-Type: application/json` only when a JSON body is
  present.
- `uploadBlobXrpc(world, { cgsUrl, token, bytes, contentType })` — raw-stream
  POST for `repo.uploadBlob` (the handler reads the raw request body, not JSON —
  see CLAUDE.md "Blob uploads").

Auth facts baked in: service-level → `aud = serviceDid`; group-scoped →
`aud = groupDid` (group must exist). Never reuse a token (single-use `jti`).

### `e2e/support/app-password.ts` — PDS helper (not a test)

Minting an app password is **not a CGS feature under test** — it is a PDS-side
operation that produces the `IMPORTER_APP_PASSWORD` config value. It lives in
`support/`, exported as `mintAppPassword({ identifier, password, name }) →
password` (login + `com.atproto.server.createAppPassword`), and is invoked by a
small script (`pnpm e2e:app-password`) or kept as the existing
`tests/smoke/create-app-password.ts`. It is **not** a `.feature`/scenario.

### `e2e/support/fixtures.ts` — lifecycle bookends

- `ensureGroupImported()` — the clean-slate routine, called from `BeforeAll`.
  Resolves `groupDid`/`ownerDid` from the configured identifiers, imports
  (`aud = serviceDid`, importer-signed), and **tolerates `GroupAlreadyRegistered`**
  (a leftover from a prior failed run): on conflict it destroys then re-imports,
  so every suite run starts from a known-imported state. No-ops cleanly (skips)
  if the importer password / app password aren't configured.
- `teardownGroup()` — called from `AfterAll`: destroys the group
  (`aud = groupDid`, owner-signed) so a successful run leaves a clean slate.
  Best-effort — a teardown failure is logged, not thrown (the next run's
  `ensureGroupImported` will reconcile it).

### `e2e/support/world.ts`

`CgsWorld extends World`, no browser. Fields: `lastHttpStatus`/`lastHttpJson`/
`lastHttpBody` (the failure hook reads the body); `serviceDid`, `groupDid`,
`groupHandle`, `ownerDid`, and the resolved role DIDs `adminDid`/`memberDid`/
`outsiderDid`; `createdRecordUri`, `uploadedBlob`. A `skipIfNo(value)` helper
returns `'pending'` when an optional secret is absent (mirrors ePDS
`skipIfNoMailpit`). Because all of these are deterministic
(`resolve(<X>_IDENTIFIER)`), each scenario's `Background` re-derives them — no
cross-scenario carryover. The per-role **passwords** are read from `testEnv` at
mint time (not stored on the World), so a step signs as owner/admin/member/
outsider by passing the matching identifier+password to `mintServiceAuth`.

### `e2e/support/hooks.ts`

`setDefaultTimeout(60_000)` (Railway cold-start + PDS login + DID resolution).
`BeforeAll` creates `reports/` **and runs `ensureGroupImported()`** so every
feature starts against a live, freshly-imported group. `AfterAll` runs
`teardownGroup()` (always runs, even on failure — exactly what we want for
teardown). On `Status.FAILED`, the `After` hook appends the last HTTP response to
`reports/e2e-failures.log`. No browser/screenshot/mailpit. The health gate is a
**step** (`Given the CGS environment is running`), not a hook, so a down
`/health` is attributed to a clear step.

### `e2e/cucumber.mjs` — profiles + tags

ePDS named-profile function form. Tag exclusions driven by which optional
secrets are present, so a minimal `.env` (just `CGS_URL` + identifiers) still
runs `/health`:

- always: `not @manual`, `not @pending`.
- `not @needs-rbac-accounts` unless **all six** RBAC vars
  (`ADMIN_*`, `MEMBER_*`, `OUTSIDER_*`) are set.

The importer and owner accounts (identifiers + passwords + the importer app
password) are **required env config** — a real run always has full credentials,
so import/records/reporting features are **not** tag-gated. The only optional
input is the **RBAC account set** (admin/member/outsider, with passwords) for the
multi-role authorization feature, gated by `@needs-rbac-accounts`. The
import/records/membership/reporting lifecycle is in the **`default`** profile —
there is no `@destructive` gate, because the target is always a throwaway test
group, and the shared bookends are fixtures. **`register.feature` is `@manual`**
(excluded from `default`/CI) because it creates a brand-new PDS account that
cannot be cleanly torn down — see below.

(Only the `/health` feature works without credentials. Everything else needs the
full `.env`; that is the expected mode, not a degraded one.)

### Two roles for import/destroy

`group.import` and `group.destroy` play two distinct roles, and that is
deliberate, not duplication:

- **As fixtures** (`BeforeAll`/`AfterAll`) — they establish and tear down the
  shared group that `records`/`membership`/`reporting` need. No assertions; pure
  setup/cleanup.
- **As `import.feature` scenarios** — they are the _subject under test_, with
  explicit assertions on the response shapes and the conflict path. Because the
  `BeforeAll` fixture has already imported the group, these scenarios assert
  against that state and the `GroupAlreadyRegistered` behaviour, and the destroy
  scenario destroys-then-re-imports so the group remains present for the other
  features and the `AfterAll`.

### Feature files

Each group-scoped feature assumes a live group (established by the `BeforeAll`
fixture). A `Background` re-derives `groupDid`/`ownerDid`/`memberDid` from the
configured identifiers.

**`features/health.feature`** — `@health`, no auth: query `/health`, assert 200
and `status == "ok"`. The only feature that doesn't need the import fixture.

**`features/import.feature`** — `group.import` + `group.destroy` as subjects
under test (`aud = serviceDid` for import, importer-signed; `aud = groupDid` for
destroy, owner-signed):

- Import the account as a group → assert `{groupDid, handle}` (the group is
  already imported by the fixture, so this asserts the idempotent/tolerant path).
- Re-import the same account → assert `GroupAlreadyRegistered`.
- Destroy the group → assert `{groupDid}`, then re-import so the group is present
  again for the remaining features.

**`features/register.feature`** (`@manual`) — `group.register`
creates a **brand-new** PDS account (`createAccount` + a PLC operation adding the
`certified_group` service to the DID doc + an app password), seeds the caller as
owner, and returns `{groupDid, handle, accountPassword}`. Tagged **`@manual`**
and excluded from `default`/CI because **it cannot be cleanly torn down**:
`group.destroy` only removes the _service's_ record of the group and explicitly
leaves the PDS account intact, so every register run leaks a real account + DID.
Run by hand against a disposable PDS when you want to exercise the path. A
**unique handle is generated per run** (the leaked account would otherwise
collide on the next run), so the first registration always succeeds; the conflict
scenario re-registers that same generated handle and asserts `HandleNotAvailable`.
Asserts `{groupDid, handle, accountPassword}`. No config var needed.

**`features/records.feature`** — the proxied repo surface, owner-signed
(`aud = groupDid`):

- Owner creates a feed post (`repo.createRecord → {uri,cid}`; store the uri).
- Owner puts a record at a known rkey (`repo.putRecord → {uri,cid}`).
- Owner uploads a blob (`repo.uploadBlob → {blob}`).
- Owner deletes the created record (`repo.deleteRecord`).

**`features/membership.feature`** (`@needs-rbac-accounts`) — RBAC across roles,
using the pre-provisioned admin/member/outsider accounts. The owner seeds the
roles, then each account **signs its own JWTs** so we test real authorization,
positive and negative (HTTP **403**, wire error `Forbidden`):

_Seeding & owner happy-path_

- Owner adds the admin account (`member.add`, role `admin` → `{memberDid,role,…}`).
- Owner adds the member account (`member.add`, role `member`).
- Owner lists members (`member.list → {members}` includes both).

_Positive — each role does what it's allowed_

- **Admin** (signing as itself) adds another member, queries audit
  (`audit.query → {entries}`) — both admin-gated, allowed.
- **Member** (signing as itself) creates a record (`repo.createRecord`) and lists
  members (`member.list`) — member-gated, allowed.

_Negative — denials (assert 403 + error `Forbidden`)_

- **Member** attempts an admin-only op (`member.add` / `audit.query`) →
  `403 "Role 'member' cannot perform '…'"`.
- **Outsider** (not a member) attempts any group op (`member.list`) →
  `403 "Not a member of this group"`.
- **Admin** attempts an owner-only op (`role.set` / `group.destroy`) → `403`.
- **Role-ceiling**: admin's `member.add` cannot assign a role ≥ its own (the
  handler caps at admin and rejects assigning ≥ caller) → `403`.

_Cleanup_

- Owner removes the admin and member accounts (`member.remove`) so the group
  returns to owner-only for the next run (the `AfterAll` destroy also covers
  this).

**`features/reporting.feature`** — read-side queries:

- Owner queries the audit log (`audit.query → {entries}`; non-empty after the
  other features have mutated the group).
- Owner lists membership (`membership.list → {groups}` includes the group).

> Cross-feature ordering note: `reporting.feature`'s "audit non-empty"
> assertion depends on the records/membership features having run first. Cucumber
> runs features in the order it discovers them (alphabetical by default), which
> happens to put `membership`/`records` before `reporting`. If that ordering ever
> needs to be guaranteed, assert audit contains _at least the import event_
> (always present after the fixture) rather than relying on prior features — the
> implementer should prefer the order-independent assertion.

### Self-cleaning + stale-data resilience

The suite reuses the **same throwaway test group account** every run. The
`BeforeAll` fixture imports it and the `AfterAll` fixture destroys it, so the
_tests themselves_ never import or destroy. To stay re-runnable even when a prior
run died before its `AfterAll`, `ensureGroupImported()` is tolerant:

1. POST import (`aud = serviceDid`, importer-signed).
2. **200** → fresh, proceed.
3. **`GroupAlreadyRegistered`** → leftover from a failed run: mint a destroy JWT
   (`aud = groupDid`, owner-signed), destroy, re-import → expect 200.
4. `AfterAll` destroys the group, so a _successful_ run leaves a clean slate;
   step 3 covers the _failed-run_ case.

Net: the suite can run indefinitely against the same test account. No
`@destructive` tag, no interactive prompt — it is always a test group, so we
keep safety low-ceremony per the agreed scope.

### Configuration (`e2e/.env.example`)

Matured superset of `tests/smoke/.env.example`:

Every e2e-only var is `E2E_`-prefixed (`E2E_GROUP_` for the per-test-group
accounts). `CGS_ADMIN_PASSWORD` is the exception — a real service-deployment
credential, not e2e-only — so it is unprefixed.

| Var                                    | Required | Notes                                                                   |
| -------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `E2E_CGS_URL`                          | yes      | CGS base URL (the only var `/health` needs)                             |
| `E2E_CGS_SERVICE_DID`                  | no       | defaults to `did:web:<E2E_CGS_URL host>`                                |
| `E2E_GROUP_IMPORTER_IDENTIFIER`        | yes      | pre-provisioned account promoted to a group (= groupDid); handle or DID |
| `E2E_GROUP_IMPORTER_PASSWORD`          | yes¹     | the importer's account password (import fixture + app-password helper)  |
| `E2E_GROUP_IMPORTER_APP_PASSWORD`      | yes¹     | app password stored by import; mint with the app-password helper        |
| `E2E_GROUP_IMPORTER_APP_PASSWORD_NAME` | no       | label for the app password the helper mints on the importer account     |
| `E2E_GROUP_OWNER_IDENTIFIER`           | yes      | pre-provisioned RBAC owner; commonly == importer                        |
| `E2E_GROUP_OWNER_PASSWORD`             | yes¹     | the owner's account password (owner-signed features)                    |
| `E2E_GROUP_ADMIN_IDENTIFIER`           | no²      | pre-provisioned account seeded as **admin** for RBAC tests              |
| `E2E_GROUP_ADMIN_PASSWORD`             | no²      | the admin's account password (so it can sign as itself)                 |
| `E2E_GROUP_MEMBER_IDENTIFIER`          | no²      | pre-provisioned account seeded as **member** for RBAC tests             |
| `E2E_GROUP_MEMBER_PASSWORD`            | no²      | the member's account password (so it can sign as itself)                |
| `E2E_GROUP_OUTSIDER_IDENTIFIER`        | no²      | pre-provisioned account that is **not** a member (negative tests)       |
| `E2E_GROUP_OUTSIDER_PASSWORD`          | no²      | the outsider's account password                                         |
| `CGS_ADMIN_PASSWORD`                   | no³      | the **service** admin password (HTTP Basic for `admin.*`); see below    |

¹ Required for everything except the `/health` feature. The PDS accounts are
provisioned up front; the suite assumes they already exist (it does **not**
create them — that is a non-goal). Only `E2E_CGS_URL` is needed to run
`--tags @health` alone.

² The RBAC feature needs **distinct pre-provisioned accounts for each role**
(admin, member, outsider) _with passwords_, so each can mint a service-auth JWT
as itself and we can assert both what each role **can** do and what it is
**denied**. These accounts are also provisioned up front. The RBAC feature is
gated `@needs-rbac-accounts` and excluded when any of the six vars is unset, so
the rest of the suite runs without them.

³ The admin-set-owner feature (`@needs-cgs-admin`) needs the **service** admin
password — the value set as `CGS_ADMIN_PASSWORD` on the CGS deployment under
test — for HTTP Basic auth on `app.certified.group.admin.*`. The feature is
excluded when it (or the RBAC accounts) is unset.

### package.json + repo wiring

- Add script `test:e2e` =
  `TSX_TSCONFIG_PATH=e2e/tsconfig.e2e.json node --import tsx/esm
./node_modules/@cucumber/cucumber/bin/cucumber-js --config e2e/cucumber.mjs`.
- Add script `e2e:app-password` = `tsx e2e/support/app-password.ts` (the helper
  that mints `IMPORTER_APP_PASSWORD`; equivalently keep using
  `tests/smoke/create-app-password.ts`).
- Add devDep `@cucumber/cucumber@^12` (the **only** new dep — no Playwright;
  `@atproto/api`, `@atproto/identity`, `dotenv`, `tsx` already present; Node-20
  global `fetch`/`AbortSignal.timeout`).
- `.gitignore`: add `reports/` and `.e2e-dist/` (`e2e/.env` already covered).
- Confirm `vitest.config.ts` does not collect `e2e/`/`features/` (step files
  don't match `*.test`/`*.spec`, so likely fine — verify, add `e2e/**` to
  `exclude` if needed).

## Trade-offs and rejected alternatives

- **Destroy via triple-gate (`@destructive` + opt-in profile + env flag).**
  Rejected: the suite _needs_ destroy to run every time to be re-runnable against
  the same account, and the target is always a throwaway test group, so the extra
  ceremony buys nothing. We rely on the clean-slate import + final teardown
  instead.
- **One big `group-lifecycle.feature`** with import → … → destroy as ordered
  scenarios. Rejected: it grows unwieldy and couples the file count to the
  lifecycle. Instead import/destroy are `BeforeAll`/`AfterAll` fixtures and the
  tests split by concern (`records` / `membership` / `reporting`), each assuming
  a live group.
- **Cross-scenario `World` carryover** (mint `groupDid` in one scenario, reuse in
  the next). Rejected: cucumber reconstructs the World per scenario, and
  `groupDid` is just `resolve(IMPORTER_IDENTIFIER)` — deterministic — so a
  `Background` re-derives it. Simpler and robust.
- **App password as a `.feature`/scenario.** Rejected: minting an app password is
  a PDS-side operation that produces a config value, not a CGS feature under
  test — it lives in `support/` as a helper script.
- **RBAC via owner-acts-only on target DIDs** (no per-role creds). Rejected: it
  only proves the methods' happy path, never that authorization is actually
  _enforced_. Real RBAC coverage needs each role to sign **its own** JWTs, so the
  env supplies pre-provisioned admin/member/outsider accounts with passwords and
  the feature asserts both allow and deny (403, wire error `Forbidden`). Caveat: one
  negative case is "admin attempts `group.destroy` → 403"; if RBAC were broken
  this would destroy the group mid-suite, but the clean-slate import + `AfterAll`
  recover the next run, and a failing 403 assertion surfaces the bug anyway.
- **Direct JWT signing** (sign with `@atproto/crypto` + `createServiceJwt`
  instead of `getServiceAuth`). Rejected for the first cut: `getServiceAuth`
  already produces compliant tokens and is exactly what the smoke scripts (and a
  real OAuth client) use; direct signing would duplicate atproto internals.

## Verification

1. `pnpm install` in the worktree (installs `@cucumber/cucumber`).
2. **Liveness**: set only `CGS_URL` (+ identifiers); `pnpm test:e2e --tags
@health` → `/health` passes, the rest excluded/pending.
3. **Full suite**: fill `e2e/.env` (throwaway importer/owner + app password + the
   RBAC account set: admin/member/outsider with passwords), point `CGS_URL` at the
   Railway preview or local `pnpm dev`; `pnpm test:e2e` → `BeforeAll` imports, the
   records/membership/reporting features run green (including RBAC allow/deny),
   `AfterAll` destroys; report at `reports/e2e.html`.
4. **Re-runnability**: run twice back-to-back → green both times (the second run's
   `BeforeAll` re-imports the freshly-destroyed group).
5. **Stale-data path**: interrupt before `AfterAll` (group left imported), re-run
   → `ensureGroupImported`'s `GroupAlreadyRegistered` branch destroys + re-imports;
   green.
6. `pnpm test` (vitest) still green and does **not** pick up `e2e/`/`features/`.
7. `pnpm lint` / `pnpm format:check` clean; `.editorconfig` respected (no
   trailing whitespace on blank lines).
