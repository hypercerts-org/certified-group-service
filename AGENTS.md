# AGENTS.md

Instructions for AI coding agents working **on this codebase**. This is the
single source of truth; `CLAUDE.md` is a symlink to this file.

**Scope:** this file is exclusively for AI-assisted development of the group
service itself — its internals, conventions, gotchas, and contributor workflow.
It is **not** documentation for users of the service or for developers building
apps on top of it; that audience is served by the XRPC API reference and
integration guide under [`docs/`](docs/). When you add notes here, keep them
contributor-facing.

## Commands

- `pnpm test` — vitest (fork-isolated per file, in-memory SQLite)
- `pnpm dev` — tsx watch
- Conventional commits: `feat|fix|chore|refactor|test|docs(scope): message`

## Changesets

Any change a downstream consumer must adapt to — XRPC endpoint/lexicon/shape,
RBAC/auth rule, env var, migration or per-group DB behaviour — **requires a
changeset** (`.changeset/<kebab-name>.md`). Skip only for internal refactors,
tests-only, CI/tooling, and docs-only changes. Follow the
[writing-changesets skill](.claude/skills/writing-changesets/SKILL.md) — read
and apply it, don't write a changeset from memory.

## Terminology

- "group service" (never "GPDS")
- "group's PDS" (never "group PDS")

## Architecture gotchas

- **Per-group databases**: each group DID is SHA256-hashed to a filename (`data/groups/{hash}.sqlite`). No reverse mapping exists — you must know the DID.
- **PDS agent auto-retry**: `PdsAgentPool.withAgent()` silently re-authenticates on 401/expired token and retries once. Don't add your own retry around it.
- **Nonce TTL is 2 minutes**, hardcoded. JWTs with longer expiry can be replayed after the nonce window closes.
- **Blob uploads** read the raw request stream into memory (not streamed to PDS). Route registration order matters: `registerRawRoutes` (uploadBlob) is mounted before `express.json()`, `registerJsonRoutes` after. New raw-stream routes go in `registerRawRoutes`.
- **Owner is created only** at group bootstrap — `group.register` and `group.import` both seed it via the shared `finalizeGroup` (`memberIndex.add(..., 'owner', ...)`) — and is immutable through the member-facing API: `role.set` rejects both promoting to owner and modifying an existing owner, `member.remove` rejects removing an owner, and `member.add` caps at admin. The **one** exception is the operator-only `app.certified.group.admin.setOwner` (HTTP Basic auth, `CGS_ADMIN_PASSWORD`), which reassigns ownership in-process via `MemberIndex.transferOwner` (demotes the old owner to admin; promotes the new owner in place, or adds them as a new owner member if they aren't a member yet — the break-glass case where the incumbent owner is unavailable).
- **Member-initiated ownership transfer** is the accept-to-confirm counterpart (`app.certified.group.ownershipTransfer.{propose,accept,cancel,status}`, `src/api/ownershipTransfer/`). The owner `propose`s an existing member; ownership only moves when that member `accept`s (their auth proves live DID control — the safeguard against handing ownership to a lost account). The must-be-a-member rule on `propose` is policy/fail-fast (single onboarding path), NOT the safety mechanism — `accept` is. `accept` reuses the same `MemberIndex.transferOwner` primitive. State lives in the per-group single-row `pending_ownership_transfer` table (`PendingTransferStore`, `src/transfer/pending.ts`); **expiry is lazy** — `get` filters on `expires_at > now` and there is no sweeper, so a stale proposal simply reads as absent (TTL `PENDING_TRANSFER_TTL_SECONDS` = 7 days). Only the owner and proposed owner can see a pending transfer (`status`); it is deliberately not on `member.list`. `propose` is owner-only; `accept`/`cancel`/`status` carry a `member` role floor because the proposed owner may be a plain member — the real gate is an in-handler identity check, not the role. **`accept` is JWT-only**: it rejects `authKind === 'apiKey'` with `ApiKeyNotPermitted`, and has no `OPERATION_LXM` entry so the scope cannot be minted onto a key in the first place (belt and braces — either alone would deny). That is what makes "auth proves live DID control" true: an API key is a bearer secret with no cryptographic tie to the DID's signing key, so it outlives the creator's ability to sign as that DID (lost PDS credentials, dead PDS, rotated DID doc) — all invisible to this service. `propose`/`cancel`/`status` stay key-accessible: propose is owner-gated and reversible, cancel is fail-safe, status is read-only.
- **Record authorship is immutable**: `onConflict(...).doNothing()` preserves original author on putRecord. Used to gate cross-author mutations — only admins can `putAnyRecord` or `deleteAnyRecord`; members can only edit/delete records they authored.
- **Profile edits** (`app.bsky.actor.profile` + rkey `self`) use a special operation `putRecord:profile` requiring admin, regardless of authorship.
- **`datetime('now')` is step-stable, not transaction-stable**: each `prepare().run()` maps to a separate `sqlite3_step()`, so two INSERTs in the same transaction can produce different timestamps. When the same timestamp must appear in multiple tables, read it back from the first INSERT and reuse it.
- **Synchronous SQLite is load-bearing for concurrency**: the driver is `better-sqlite3` (sync) on Node's single event loop, so a `raw.transaction(...)` runs to completion without yielding — handlers cannot interleave _within_ a transaction, only at `await` boundaries _between_ DB calls. Several read-modify-write flows depend on this (notably ownership transfer: `admin.setOwner` clears a pending proposal _after_ its `transferOwner` txn, and a racing `accept` stays safe only because `accept` re-reads the current owner and `transferOwner` is atomic). Don't switch to an async driver (`node:sqlite` worker, libsql, parallel pool) without re-auditing these flows for mid-transaction interleaving. See `src/db/sqlite.ts` and the Concurrency model in `docs/architecture.md`.

## Testing

- `pnpm test` exits after one run (no watch mode). Redirect output to a temp file so you can inspect failures without re-running: `pnpm test > /tmp/test-output.log 2>&1` then read the file.
- `createTestContext(overrides?)` in `tests/helpers/mock-server.ts` — builds a full `AppContext` with in-memory DBs and mocks. Pass `Partial<AppContext>` to override.
- Default mock auth returns `{ iss: 'did:plc:testuser', aud: 'did:plc:testgroup' }`. Override `authVerifier.verify` to test other callers.
- `seedMember(groupDb, did, role)` and `seedAuthorship(groupDb, uri, did, collection)` are the main test helpers.
- Tests run in forked processes — in-memory state resets per file but not per test within a file.

## Testing & Coverage

```bash
pnpm test            # vitest run (fork-isolated, in-memory SQLite)
pnpm test:coverage   # vitest run --coverage — enforces thresholds below
```

Coverage uses the v8 provider (`@vitest/coverage-v8`). Reporters: `text`
(terminal), `html` (`coverage/index.html`), and `lcov` (`coverage/lcov.info`,
uploaded to Coveralls in CI). Configuration lives in `vitest.config.ts`.

The `coverage.include` glob is `src/**/*.ts`. Excluded from the denominator:

- `**/*.test.ts`, `**/*.d.ts` — test and declaration files.
- `src/index.ts` — process bootstrap, no testable logic.
- `src/context.ts`, `src/db/schema.ts` — type-only modules (`interface` /
  `import type`); they emit no runtime code, so v8 reports them as 0% and
  skews the totals.

### Coverage Ratcheting Policy

Coverage thresholds in `vitest.config.ts` must **only ever increase**.
When a PR raises coverage above the current thresholds, ratchet the
thresholds up to the new floor (rounded down to the nearest integer) in the
same PR. This ensures coverage can never regress.

```ts
thresholds: {
  statements: <new floor>,
  branches: <new floor>,
  functions: <new floor>,
  lines: <new floor>,
},
```

**Never lower thresholds.** If a change removes tested code (e.g. deleting a
feature), add tests for other code to compensate.

## Coverage Summary

Baseline as of this document (516 tests across 39 files):

| Metric     | Coverage | Threshold |
| ---------- | -------- | --------- |
| Statements | 95.11%   | 95        |
| Branches   | 91.66%   | 91        |
| Functions  | 93.51%   | 93        |
| Lines      | 95.11%   | 95        |

### Known gaps (highest impact first)

- **`src/pds/plc.ts` — 4.25%** (lines 51-119). Custom PLC operation helpers:
  DAG-CBOR encode → SHA-256 → secp256k1 sign → base64url. The biggest gap and
  the best low-hanging fruit — these are pure, deterministic functions and are
  **unit-testable** with a fixed keypair (no network). `generateRecoveryKey`
  and the signing/encoding path have no test yet.
- **`src/api/index.ts` — 0%** (lines 1-32). `registerXrpcMethods` is pure
  registration glue that wires each handler into the XRPC server. Integration-
  level, not unit-level — cover it by booting the server in a supertest
  integration test rather than unit-testing the registrar.
- **`src/config.ts` — 56%** (lines 29-45). Environment-variable parsing
  branch. Unit-testable by setting `process.env` and asserting the parsed
  `Config`.
- **Migrations — 75-90%.** `down()` / index-drop paths in
  `group/002_audit_indexes.ts` and `group/001_initial.ts` are unexercised.
  Low priority unless rollback is part of the supported flow.

### Guidelines for adding tests

- **Prefer unit tests for pure logic** — crypto (`pds/plc.ts`), RBAC
  (`rbac/`), validation, DB operations. See `src/api/util.test.ts` and
  `src/pds/agent.test.ts` for the established style.
- **Use in-memory / temp SQLite for DB tests.** `createTestContext()` in
  `tests/helpers/mock-server.ts` builds a full `AppContext` with in-memory
  DBs and mocks; `seedMember` / `seedAuthorship` seed fixtures.
- **Do not unit-test route registration glue** (`api/index.ts`) — cover it
  via supertest integration tests that boot the server.
- **Mock external services** (PLC directory, PDS HTTP) rather than hitting the
  network. Default mock auth returns
  `{ iss: 'did:plc:testuser', aud: 'did:plc:testgroup' }`; override
  `authVerifier.verify` for other callers.
- **Keep this summary current** — when you close a documented gap or find a
  new one, update the table and gap list, then ratchet the thresholds.
