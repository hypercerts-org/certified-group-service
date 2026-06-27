# Checking and interpreting a deployment's version

> Read this file to find out which version of CGS a deployment is running and
> what that version number means for your integration. The health-check response
> shape is in `docs/api-reference.md`; the release/changelog process is in
> `docs/PUBLISHING.md` (contributor-facing).

## Reading the running version

`GET /health` (alias `GET /xrpc/_health`) — **no auth**, no `repo`. Returns:

```json
{ "status": "ok", "service": "group-service", "version": "0.1.0+90d10b96" }
```

The `version` is resolved from the `CGS_VERSION` env var, then a build-time
`.cgs-version` file, then `package.json` (first match wins). When the global
database is unreachable both paths return `503` with
`{ "status": "error", "message": "database unreachable" }`. Full response shape:
[api-reference.md#health-check](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#health-check).

**Not every deployment exposes `version` yet.** A given instance only reports a
`version` once it has been upgraded to a build that resolves one. At the time of
writing the staging (`dev.groups.certified.app`) and test
(`test.groups.certified.app`) instances expose it; the production instance
(`groups.certified.app`) does not yet (it will after its next upgrade). The
current Certified deployment hostnames are listed at
[docs.hypercerts.org/reference/certified-group-services](https://docs.hypercerts.org/reference/certified-group-services).

## What the number means

The string is **semver** plus build metadata: `<major>.<minor>.<patch>+<build>`.
CGS is versioned as a **single product** — one version covers the whole service
(there is no per-endpoint versioning). A release is a git tag `v<major>.<minor>.<patch>`
with a matching GitHub Release.

**Pre-1.0 — the part that bites.** While the version is `0.x`, the API is not yet
under the semver stability guarantee: a **minor** bump (`0.1` → `0.2`) may carry a
breaking change to the XRPC API, RBAC rules, or `aud`/`repo` behavior. Do **not**
assume only `major` bumps break you until the service reaches `1.0.0`. Read the
release notes before upgrading the deployment you build against.

## Where the release notes are

- **GitHub Releases** (one per tag): https://github.com/hypercerts-org/certified-group-service/releases
- **`CHANGELOG.md`** at the repo root: https://github.com/hypercerts-org/certified-group-service/blob/main/CHANGELOG.md

Map a deployment's `version` to the matching `v<version>` release to see exactly
what changed and whether a behavior you depend on is present.
