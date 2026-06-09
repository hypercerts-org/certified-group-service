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

## Terminology

- "group service" (never "GPDS")
- "group's PDS" (never "group PDS")

## Architecture gotchas

- **Per-group databases**: each group DID is SHA256-hashed to a filename (`data/groups/{hash}.sqlite`). No reverse mapping exists — you must know the DID.
- **PDS agent auto-retry**: `PdsAgentPool.withAgent()` silently re-authenticates on 401/expired token and retries once. Don't add your own retry around it.
- **Nonce TTL is 2 minutes**, hardcoded. JWTs with longer expiry can be replayed after the nonce window closes.
- **Blob uploads** read the raw request stream into memory (not streamed to PDS). Route registration order matters: `registerRawRoutes` (uploadBlob) is mounted before `express.json()`, `registerJsonRoutes` after. New raw-stream routes go in `registerRawRoutes`.
- **Owner is created only** via `group.register` (seeds DB) and is immutable thereafter: `role.set` rejects both promoting to owner and modifying an existing owner, and `member.remove` rejects removing an owner. `member.add` caps at admin. Ownership transfer is a separate, not-yet-implemented operation.
- **Record authorship is immutable**: `onConflict(...).doNothing()` preserves original author on putRecord. Used to gate cross-author mutations — only admins can `putAnyRecord` or `deleteAnyRecord`; members can only edit/delete records they authored.
- **Profile edits** (`app.bsky.actor.profile` + rkey `self`) use a special operation `putRecord:profile` requiring admin, regardless of authorship.
- **`datetime('now')` is step-stable, not transaction-stable**: each `prepare().run()` maps to a separate `sqlite3_step()`, so two INSERTs in the same transaction can produce different timestamps. When the same timestamp must appear in multiple tables, read it back from the first INSERT and reuse it.

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

Baseline as of this document (421 tests across 36 files):

| Metric     | Coverage | Threshold |
| ---------- | -------- | --------- |
| Statements | 94.38%   | 94        |
| Branches   | 91%      | 91        |
| Functions  | 92.54%   | 92        |
| Lines      | 94.38%   | 94        |

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
