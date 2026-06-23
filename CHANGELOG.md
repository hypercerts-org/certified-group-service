# group-service

## 0.2.0

### Who should read this release

- **End users:**
  - [A group's owner can now remove the group from the service.](#v0.2.0-a-group-s-owner-can-now-remove-the-group-from-the-service)
- **Client app developers:**
  - [Apps now name the target group with an explicit `repo` field instead of overloading the service-auth token's audience.](#v0.2.0-apps-now-name-the-target-group-with-an-explicit-field)
  - [A group's owner can now remove the group from the service.](#v0.2.0-a-group-s-owner-can-now-remove-the-group-from-the-service)
  - [You can now turn an existing account into a group, instead of always creating a brand-new one.](#v0.2.0-you-can-now-turn-an-existing-account-into-a-group-instead)
  - [The health check now reports the running service version, and the same check is also reachable at `/xrpc/_health`.](#v0.2.0-the-health-check-now-reports-the-running-service-version)
- **Operators:**
  - [Apps now name the target group with an explicit `repo` field instead of overloading the service-auth token's audience.](#v0.2.0-apps-now-name-the-target-group-with-an-explicit-field)
  - [A group's owner can now remove the group from the service.](#v0.2.0-a-group-s-owner-can-now-remove-the-group-from-the-service)
  - [You can now turn an existing account into a group, instead of always creating a brand-new one.](#v0.2.0-you-can-now-turn-an-existing-account-into-a-group-instead)
  - [The health check now reports the running service version, and the same check is also reachable at `/xrpc/_health`.](#v0.2.0-the-health-check-now-reports-the-running-service-version)

### Minor Changes

- <a id="v0.2.0-apps-now-name-the-target-group-with-an-explicit-field"></a> [#33](https://github.com/hypercerts-org/certified-group-service/pull/33) [`677298e`](https://github.com/hypercerts-org/certified-group-service/commit/677298eaa00e707295165b43d5d68f5ca1ad4d37) Thanks [@aspiers](https://github.com/aspiers)! - Apps now name the target group with an explicit `repo` field instead of overloading the service-auth token's audience.

  **Affects:** Client app developers, Operators

  **Client app developers:** group-scoped methods take a `repo` field (a handle or DID) naming the target group, with the JWT `aud` set to the service DID — the shape a stock `@atproto/api` client already emits. The old form (group in `aud`, no `repo`) still works but is deprecated.

  |                    | Legacy (deprecated)          | New (supported)     |
  | ------------------ | ---------------------------- | ------------------- |
  | Group named by     | JWT `aud`                    | explicit `repo`     |
  | JWT `aud`          | the **group** DID            | the **service** DID |
  | `repo` field       | absent                       | present             |
  | Deprecation header | `Deprecation: true` + `Link` | none                |
  - **Behaviour change to adapt to now:** `repo` is the group selector, not a cross-check — the old `403` "repo field must match the group DID" is gone; a `repo` naming no registered group returns `401 Unknown group`. RBAC is unchanged: you can only target groups you have a role in.
  - **How to migrate** (per-method `repo` placement, the coupled `repo`+`aud` switch, non-proxied vs proxied calls, detecting un-migrated calls): see **`docs/aud-migration.md`**. Design rationale and security analysis: `docs/design/aud-deprecation.md`.

  **Operators:** no new environment variables and no migration; `SERVICE_DID` is unchanged. The service now serves its `did:web` document at `GET /.well-known/did.json` (a public, unauthenticated route, sibling to `/health`); it must be publicly reachable, since that is how the service DID resolves and how service proxying targets the service. A rate-limited `warn` log flags any client still on the legacy form — one line per caller per 15 minutes.

- <a id="v0.2.0-a-group-s-owner-can-now-remove-the-group-from-the-service"></a> [#30](https://github.com/hypercerts-org/certified-group-service/pull/30) [`e4a0aac`](https://github.com/hypercerts-org/certified-group-service/commit/e4a0aacdbddc3489879088feaa52aa0c1bcfd433) Thanks [@aspiers](https://github.com/aspiers)! - A group's owner can now remove the group from the service.

  **Affects:** End users, Client app developers, Operators

  **End users:** if you are a group's owner, you can now delete the group from the service. This removes the group and its membership from the service only — the underlying account and its data are left untouched, so the account continues to exist and could be added back later. Only the owner can do this; admins and members cannot.

  **Client app developers:** a new procedure `app.certified.group.destroy` removes a group from the service, gated on the `owner` role (new RBAC operation `group.destroy`). It removes only the service's record of the group; the underlying PDS account is left intact, so the account can be re-imported afterwards via `app.certified.group.import`. Call it group-scoped, the same auth style as the other per-group methods. Full request/response and errors are in `docs/api-reference.md` and `docs/integration-guide.md`.

  Heads-up: like the other per-group methods, `destroy` currently names the target group via the JWT `aud`. That overload is being deprecated (issue #27) in favour of an explicit request-level group field, with `aud` reverting to the group service's own DID. The `aud` = group DID form will be supported during a transition window and then removed — build against the explicit-group form once it ships.

  **Operators:** `destroy` is served on `/xrpc/app.certified.group.destroy`; no new environment variables. It deletes the group's `groups` row and `member_index` entries (in one transaction) and then the per-group SQLite file under `data/groups/`. The destroy is recorded in the service log, not in the (deleted) per-group audit log.

- <a id="v0.2.0-you-can-now-turn-an-existing-account-into-a-group-instead"></a> [#30](https://github.com/hypercerts-org/certified-group-service/pull/30) [`f265075`](https://github.com/hypercerts-org/certified-group-service/commit/f265075d196e1a7ce936dd7b555ec084fd78377b) Thanks [@aspiers](https://github.com/aspiers)! - You can now turn an existing account into a group, instead of always creating a brand-new one.

  **Affects:** Client app developers, Operators

  **Client app developers:** a new procedure `app.certified.group.import` is the sibling of `app.certified.group.register` — it reuses an existing account instead of creating one. You supply the account's app password so the service can act on its behalf, and the JWT must be signed by the account being imported (`iss` = the account's DID), not by the prospective owner. Two consequences worth knowing: the service holds **no recovery key** for an imported account (the owner's own credentials are their credible exit), and `import` does not modify the account's DID document. Full request/response, auth model, and errors are in `docs/api-reference.md` (Group lifecycle), `docs/integration-guide.md` (Step 1b), and `docs/design/group-import.md`.

  **Operators:** `import` is served on `/xrpc/app.certified.group.import` (service-auth, like `register`); no new environment variables. Imported groups are stored in the `groups` table with `encrypted_recovery_key` left `NULL`, distinguishing them from registered groups, and are driven via the per-group `pds_url` resolved at import time — which may differ from `GROUP_PDS_URL`.

- <a id="v0.2.0-the-health-check-now-reports-the-running-service-version"></a> [#35](https://github.com/hypercerts-org/certified-group-service/pull/35) [`a906bd8`](https://github.com/hypercerts-org/certified-group-service/commit/a906bd85e8f096e0756d7315905071fba84f4493) Thanks [@aspiers](https://github.com/aspiers)! - The health check now reports the running service version, and the same check is also reachable at `/xrpc/_health`.

  **Affects:** Client app developers, Operators

  **Client app developers:**
  - `GET /health` response gains two fields: `service` (always `"group-service"`) and `version` (e.g. `"0.1.0+90d10b96"`). The existing `status: "ok"` / `503 { status: "error", message: "database unreachable" }` behaviour is unchanged, so existing health checks keep working.
  - A new `GET /xrpc/_health` route returns the identical body to `/health` (including the same 503-on-DB-failure semantics). This mirrors the upstream PDS convention of exposing `/xrpc/_health`; the group service has no upstream PDS, so it serves the route itself. Note it returns the full `{ status, service, version }` object, not the bare `{ version }` some atproto services return.

  **Operators:**
  - The reported version resolves in this order: the `CGS_VERSION` env var, then a `.cgs-version` file written at image-build time, then the `version` field in `package.json`. Set `CGS_VERSION` to override the stamp (e.g. `CGS_VERSION=0.1.0+abcdef01`).
  - On Railway, the Docker build stamps `<package.json version>+<short commit sha>` automatically from `RAILWAY_GIT_COMMIT_SHA` — no action needed.
  - For local `docker build`, run `./scripts/stamp-version.sh` first to write `.cgs-version`; the build fails with `ERROR: .cgs-version not found` otherwise. `.cgs-version` is gitignored.

## 0.1.0

Initial release — the baseline that was already deployed before
changeset-based release notes were adopted, recorded here so the
changelog has a starting point rather than retroactively itemising
shipped features as if they were new.

The 0.1.0 feature set (group registration, role-based access control,
record proxying to each group's PDS with author-scoped edit/delete
gating, blob upload, the per-group audit log, atproto service-auth
with replay protection, and cross-group membership discovery) is
documented in `README.md` and `docs/`. Subsequent releases document
only what changes after this point, via changesets — see
`docs/PUBLISHING.md`.
