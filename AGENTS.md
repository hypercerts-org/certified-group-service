# AGENTS.md

Agent-facing notes for the group service. For architecture gotchas and
day-to-day commands, see [`CLAUDE.md`](CLAUDE.md).

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

Baseline as of this document (240 tests across 23 files):

| Metric     | Coverage | Threshold |
| ---------- | -------- | --------- |
| Statements | 91.65%   | 91        |
| Branches   | 91.85%   | 91        |
| Functions  | 87.61%   | 87        |
| Lines      | 91.65%   | 91        |

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
- **`src/auth/verifier.ts` — 83%** (lines 119-144). JWT verification error
  paths (malformed/expired/wrong-audience). Unit-testable by feeding crafted
  tokens; complements the existing nonce tests.
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
