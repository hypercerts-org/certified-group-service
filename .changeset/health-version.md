---
'group-service': minor
---

The health check now reports the running service version, and the same check is also reachable at `/xrpc/_health`.

**Affects:** Client app developers, Operators

**Client app developers:**

- `GET /health` response gains two fields: `service` (always `"group-service"`) and `version` (e.g. `"0.1.0+90d10b96"`). The existing `status: "ok"` / `503 { status: "error", message: "database unreachable" }` behaviour is unchanged, so existing health checks keep working.
- A new `GET /xrpc/_health` route returns the identical body to `/health` (including the same 503-on-DB-failure semantics). This mirrors the upstream PDS convention of exposing `/xrpc/_health`; the group service has no upstream PDS, so it serves the route itself. Note it returns the full `{ status, service, version }` object, not the bare `{ version }` some atproto services return.

**Operators:**

- The reported version resolves in this order: the `CGS_VERSION` env var, then a `.cgs-version` file written at image-build time, then the `version` field in `package.json`. Set `CGS_VERSION` to override the stamp (e.g. `CGS_VERSION=0.1.0+abcdef01`).
- On Railway, the Docker build stamps `<package.json version>+<short commit sha>` automatically from `RAILWAY_GIT_COMMIT_SHA` — no action needed.
- For local `docker build`, run `./scripts/stamp-version.sh` first to write `.cgs-version`; the build fails with `ERROR: .cgs-version not found` otherwise. `.cgs-version` is gitignored.
