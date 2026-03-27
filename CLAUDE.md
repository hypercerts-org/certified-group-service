# CLAUDE.md

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
- **Owner can only be created** via `group.register` (seeds DB) or `role.set` (owner-only). `member.add` caps at admin.
- **Record authorship is immutable**: `onConflict(...).doNothing()` preserves original author on putRecord. Used for "who can delete this" (only admins can `deleteAnyRecord`); any member can edit any record regardless of authorship.
- **Profile edits** (`app.bsky.actor.profile` + rkey `self`) use a special operation `putRecord:profile` requiring admin, regardless of authorship.
- **`datetime('now')` is step-stable, not transaction-stable**: each `prepare().run()` maps to a separate `sqlite3_step()`, so two INSERTs in the same transaction can produce different timestamps. When the same timestamp must appear in multiple tables, read it back from the first INSERT and reuse it.

## Testing
- `pnpm test` exits after one run (no watch mode). Redirect output to a temp file so you can inspect failures without re-running: `pnpm test > /tmp/test-output.log 2>&1` then read the file.
- `createTestContext(overrides?)` in `tests/helpers/mock-server.ts` — builds a full `AppContext` with in-memory DBs and mocks. Pass `Partial<AppContext>` to override.
- Default mock auth returns `{ iss: 'did:plc:testuser', aud: 'did:plc:testgroup' }`. Override `authVerifier.verify` to test other callers.
- `seedMember(groupDb, did, role)` and `seedAuthorship(groupDb, uri, did, collection)` are the main test helpers.
- Tests run in forked processes — in-memory state resets per file but not per test within a file.
