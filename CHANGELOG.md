# group-service

## 0.6.2

### Who should read this release

- **Client app developers:**
  - [API keys can no longer call `member.add`, `member.remove` or `role.set`. This capability is withdrawn, and there is no long-lived replacement.](#v0.6.2-api-keys-can-no-longer-call-or-this-capability-is-withdrawn)
- **Operators:**
  - [The group service is now licensed under Apache-2.0; version 0.6.1 and earlier remain available under MIT.](#v0.6.2-the-group-service-is-now-licensed-under-apache-2-0-version)

### Patch Changes

- <a id="v0.6.2-the-group-service-is-now-licensed-under-apache-2-0-version"></a> [#88](https://github.com/hypercerts-org/certified-group-service/pull/88) [`92ae50d`](https://github.com/hypercerts-org/certified-group-service/commit/92ae50d62e208a6af6ee38909793d3b192b8c422) Thanks [@holkexyz](https://github.com/holkexyz)! - The group service is now licensed under Apache-2.0; version 0.6.1 and earlier remain available under MIT.

  **Affects:** Operators

  **Operators:** the container image now carries `LICENSE` and `NOTICE` in `/app`. If you redistribute the service or a modified version of it, including a rebuilt or mirrored image, include `LICENSE`, keep the text of `NOTICE`, mark any files you changed, and meet the other conditions in section 4 of the Apache License. Running the service yourself needs no change.

- <a id="v0.6.2-api-keys-can-no-longer-call-or-this-capability-is-withdrawn"></a> [#87](https://github.com/hypercerts-org/certified-group-service/pull/87) [`07cb803`](https://github.com/hypercerts-org/certified-group-service/commit/07cb8035cc337ae2aed0ddfd47ca4ec8ef78b270) Thanks [@Kzoeps](https://github.com/Kzoeps)! - API keys can no longer call `member.add`, `member.remove` or `role.set`. This capability is withdrawn, and there is no long-lived replacement.

  **Affects:** Client app developers

  **Client app developers:** `app.certified.group.member.add`, `app.certified.group.member.remove` and `app.certified.group.role.set` now return `403 ApiKeyNotPermitted` for any `X-API-Key` caller, whatever scopes the key holds (including `rpc:*`). Keys were never meant to manage membership; these three methods skipped the key's scope check by mistake. That gap also let any key remove the member who created it through the self-removal path, which is now closed. Each refused call is written to the audit log with the key's `apiKeyRef`. Automation that managed members with an API key must switch to a per-request service-auth JWT signed by a member with the required role.

## 0.6.1

### Who should read this release

- **Client app developers:**
  - [A request to change someone's role to something that is not a real role is now always refused.](#v0.6.1-a-request-to-change-someone-s-role-to-something-that-is-not)
  - [Overlapping ownership changes on the same group can no longer undo one another.](#v0.6.1-overlapping-ownership-changes-on-the-same-group-can-no)
- **Operators:**
  - [Request logs no longer record credential-bearing headers such as `Authorization`, `X-API-Key` and `Cookie`.](#v0.6.1-request-logs-no-longer-record-credential-bearing-headers)
  - [Overlapping ownership changes on the same group can no longer undo one another.](#v0.6.1-overlapping-ownership-changes-on-the-same-group-can-no)

### Patch Changes

- <a id="v0.6.1-request-logs-no-longer-record-credential-bearing-headers"></a> [#83](https://github.com/hypercerts-org/certified-group-service/pull/83) [`e61871f`](https://github.com/hypercerts-org/certified-group-service/commit/e61871f80971c4e38d1f1efae07baf2f954c95f9) Thanks [@Kzoeps](https://github.com/Kzoeps)! - Request logs no longer record credential-bearing headers such as `Authorization`, `X-API-Key` and `Cookie`.

  **Affects:** Operators

  **Operators:**
  - Access logs now keep only `host`, `user-agent`, `content-type`, `content-length`, `atproto-proxy` and `x-request-id`. Other headers, including `x-forwarded-for`, are dropped. The client IP is logged as `req.ip`, resolved through the trusted proxy hop; `req.remoteAddress` is the proxy.
  - Earlier logs may contain API keys and the `CGS_ADMIN_PASSWORD` Basic credential. If those logs were readable outside trusted operators, rotate both. Service-auth JWTs expire within 120 seconds and need no rotation.

- <a id="v0.6.1-a-request-to-change-someone-s-role-to-something-that-is-not"></a> [#80](https://github.com/hypercerts-org/certified-group-service/pull/80) [`97b693e`](https://github.com/hypercerts-org/certified-group-service/commit/97b693ecd541163c97f436cc145af16a1908dece) Thanks [@Ashex](https://github.com/Ashex)! - A request to change someone's role to something that is not a real role is now always refused.

  **Affects:** Client app developers

  **Client app developers:** `app.certified.group.role.set` validated its `role` field with a JavaScript `in` check against the role table, which also matches inherited object keys. `role: "toString"` (and any other `Object.prototype` key) therefore passed validation and was written to the member row verbatim, leaving a member with a role no permission check recognises. Such a value is now rejected like any other unknown role, with `400 InvalidRole` and the message `Role must be one of: member, admin, owner`. Valid values (`member`, `admin`) are unaffected, and an existing group that was written a bogus role by the old code keeps it — re-set that member's role to repair the row.

- <a id="v0.6.1-overlapping-ownership-changes-on-the-same-group-can-no"></a> [#80](https://github.com/hypercerts-org/certified-group-service/pull/80) [`140468a`](https://github.com/hypercerts-org/certified-group-service/commit/140468ab3d12f77bdc617bad8f805ddafda08dd9) Thanks [@Ashex](https://github.com/Ashex)! - Overlapping ownership changes on the same group can no longer undo one another.

  **Affects:** Client app developers, Operators

  **Client app developers:** `app.certified.group.ownershipTransfer.propose`, `accept` and `cancel`, and the operator endpoint `app.certified.group.admin.setOwner`, now run one at a time per group. Each validates and writes as a unit, so two requests that arrive together resolve in a defined order instead of one acting on state the other has already replaced. Two responses change in that race: a `propose` that loses the race to `admin.setOwner` is refused with `403` rather than recording a proposal signed by the demoted owner, and a `cancel` whose proposal was replaced while it ran returns `404 NoPendingTransfer` rather than cancelling the replacement. An `accept` whose recipient is removed from the group while it runs returns the same `404` instead of making that removed account the owner. Uncontended requests are unaffected, and no new error codes are introduced.

  **Operators:** serialization is per group and in-process, so it holds for one service instance per group database — the arrangement the per-group SQLite files already assume. Running two instances against the same data directory does not serialize these flows.

## 0.6.0

### Who should read this release

- **End users:**
  - [A group's owner can now hand ownership to another member, who must accept before it takes effect.](#v0.6.0-a-group-s-owner-can-now-hand-ownership-to-another-member)
- **Client app developers:**
  - [A group's owner can now hand ownership to another member, who must accept before it takes effect.](#v0.6.0-a-group-s-owner-can-now-hand-ownership-to-another-member)
  - [An API key requesting "everything I'm allowed to do" is no longer refused for members and admins.](#v0.6.0-an-api-key-requesting-everything-i-m-allowed-to-do-is-no)

### Minor Changes

- <a id="v0.6.0-a-group-s-owner-can-now-hand-ownership-to-another-member"></a> [#72](https://github.com/hypercerts-org/certified-group-service/pull/72) [`cfe0d40`](https://github.com/hypercerts-org/certified-group-service/commit/cfe0d40bcb93743d746682dc171046ee8d81b34c) Thanks [@aspiers](https://github.com/aspiers)! - A group's owner can now hand ownership to another member, who must accept before it takes effect.

  **Affects:** End users, Client app developers

  **End users:** once the app you use adds support for it, owning a group lets you transfer ownership to another member yourself instead of asking an operator. You propose them, and ownership only moves once they accept by signing in themselves — so it can't be handed to someone who has lost access to their account. Either of you can cancel before then, and an un-accepted transfer expires after 7 days. Only the two of you can see a transfer in progress.

  **Client app developers:**
  - Four new methods under `app.certified.group.ownershipTransfer.*`: `propose`, `accept`, `cancel` (procedures) and `status` (query). See [Ownership transfer](docs/api-reference.md#ownership-transfer) for the contract.
  - `propose` is owner-only; `accept` is callable only by the proposed member; `cancel` and `status` by either party. `status` is deliberately not exposed on `member.list`.
  - **A non-party cannot detect that a transfer exists.** Whether or not one is pending, a member who is not a party gets the same response: `{ "pending": false }` from `status`, and `404 NoPendingTransfer` from `accept` and `cancel`. There are no `NotPartyToTransfer` or `NotProposedOwner` errors — a distinct code would itself be the disclosure. Do not branch on the difference between "no transfer" and "not yours" in client code; it is not observable. When a transfer is pending, the group's audit log records the true reason a non-party was refused; a request that finds nothing pending is not logged.
  - `propose`, `cancel` and `status` accept a service-auth JWT or an API key with the matching `rpc:` scope, subject to the caller's role (so a key can only `propose` if issued by the owner).
  - `accept` is **JWT-only**. An API-key request is refused with `403 ApiKeyNotPermitted`, and there is no `rpc:` scope for it — `app.certified.group.ownershipTransfer.accept` cannot be granted to a key, and a wildcard `rpc:*` scope does not cover it. Acceptance is what proves the incoming owner still controls their account, and an API key keeps working after its creator can no longer authenticate as that DID, so a key could otherwise park ownership on an unrecoverable account. Apps that automate group admin with a key must route this one step through the user's own authenticated session.
  - A pending proposal is cleared automatically when ownership or a party's membership changes by another route (`admin.setOwner`, `member.remove`, `role.set`), so a stale proposal can never be accepted to revert those changes.

- <a id="v0.6.0-an-api-key-requesting-everything-i-m-allowed-to-do-is-no"></a> [#72](https://github.com/hypercerts-org/certified-group-service/pull/72) [`46a3aa4`](https://github.com/hypercerts-org/certified-group-service/commit/46a3aa48c3c1cc8b7c22f270d23585813c83ee7e) Thanks [@aspiers](https://github.com/aspiers)! - An API key requesting "everything I'm allowed to do" is no longer refused for members and admins.

  **Affects:** Client app developers

  **Client app developers:**
  - `keys.create` no longer rejects a wildcard `rpc:*` scope on the basis of the creator's role. Previously the wildcard was expanded to every key-accessible operation and each was role-checked, so the whole request failed if any single one outranked the caller — in practice `rpc:*` was refused for members (blocked by the admin-only `audit.query`) and, once ownership transfer added the owner-only `ownershipTransfer.propose`, for admins too.
  - A wildcard now always passes creation and grants whatever the issuing member's role permits **at request time**. A member's `rpc:*` key can call `member.list` but is still refused `audit.query` with a `403`; the cap follows the issuer's current role, so promotion or demotion widens or narrows an existing key with no re-issue.
  - Enumerated scopes are unchanged: naming an operation your role cannot use is still rejected at creation with `role '<role>' cannot use scope for '<operation>'`. The fail-fast behaviour applies where you made a specific claim, not where you asked for whatever is available.
  - No key gains access it did not have before. Request-time RBAC was always the enforcement point; this only stops refusing to mint keys that would have been correctly capped anyway.

## 0.5.0

### Who should read this release

- **Operators:**
  - [Operators can reassign a group's owner through a new admin API.](#v0.5.0-operators-can-reassign-a-group-s-owner-through-a-new-admin)

### Minor Changes

- <a id="v0.5.0-operators-can-reassign-a-group-s-owner-through-a-new-admin"></a> [#61](https://github.com/hypercerts-org/certified-group-service/pull/61) [`4a73f38`](https://github.com/hypercerts-org/certified-group-service/commit/4a73f385a83ec0aa8a6a4cf845be5a555b6bc99b) Thanks [@aspiers](https://github.com/aspiers)! - Operators can reassign a group's owner through a new admin API.

  **Affects:** Operators

  This adds an operator-only admin endpoint. It is deliberately **not** part of the member-facing API — it is authenticated with the service admin password, not a member's JWT or API key — so client app developers building on the group service have nothing to call or adapt; only operators running an instance are affected.

  **Operators:** a new optional env var `CGS_ADMIN_PASSWORD` enables operator-only admin endpoints (`app.certified.group.admin.*`), authenticated with HTTP Basic auth rather than group membership — the same mechanism the upstream AT Protocol reference PDS uses for `com.atproto.admin.*`. When unset, all admin endpoints are disabled. The trust model is the one a PDS operator already operates under, applied to the groups CGS hosts; admin actions are audit-logged. The first such endpoint, `app.certified.group.admin.setOwner`, reassigns a group's owner (including installing an owner who is not yet a member, for operator recovery when the incumbent is unavailable). See `docs/deployment.md#admin-endpoints` and the API reference for configuration and the endpoint contract.

## 0.4.0

### Who should read this release

- **Client app developers:**
  - [Allow all group members to create, list, and revoke their own API keys. Owners retain group-wide visibility and revocation, while API-key auth itself still cannot manage keys.](#v0.4.0-allow-all-group-members-to-create-list-and-revoke-their-own)

### Minor Changes

- <a id="v0.4.0-allow-all-group-members-to-create-list-and-revoke-their-own"></a> [#58](https://github.com/hypercerts-org/certified-group-service/pull/58) [`fb0e253`](https://github.com/hypercerts-org/certified-group-service/commit/fb0e253946492dee8e8718ed2ae838b79a018679) Thanks [@aspiers](https://github.com/aspiers)! - Allow all group members to create, list, and revoke their own API keys. Owners
  retain group-wide visibility and revocation, while API-key auth itself still
  cannot manage keys.

  **Affects:** Client app developers

## 0.3.0

### Who should read this release

- **Client app developers:**
  - [Backend services can now use revocable API keys for group-owned records.](#v0.3.0-backend-services-can-now-use-revocable-api-keys-for-group)
- **Operators:**
  - [Backend services can now use revocable API keys for group-owned records.](#v0.3.0-backend-services-can-now-use-revocable-api-keys-for-group)
  - [Authentication failures are now logged server-side, so an operator can diagnose a rejected request from the logs instead of having to reproduce it.](#v0.3.0-authentication-failures-are-now-logged-server-side-so-an)

### Minor Changes

- <a id="v0.3.0-backend-services-can-now-use-revocable-api-keys-for-group"></a> [#34](https://github.com/hypercerts-org/certified-group-service/pull/34) [`e6c8f87`](https://github.com/hypercerts-org/certified-group-service/commit/e6c8f87d6c129412f54a2eedd2cff4d99e47990e) Thanks [@aspiers](https://github.com/aspiers)! - Backend services can now use revocable API keys for group-owned records.

  **Affects:** Client app developers, Operators

  **Client app developers:** group owners can create, list, and revoke keys with `app.certified.group.keys.create`, `app.certified.group.keys.list`, and `app.certified.group.keys.delete`. Key auth uses `X-API-Key` and supports explicit scopes plus reusable permission-set scopes such as `include:org.hypercerts.authWrite`, so apps no longer need to list every record permission by hand. See `docs/design/api-keys.md`, `docs/design/api-key-permission-sets.md`, and `docs/integration-guide.md` for request shapes, supported permissions, and examples.

  **Operators:** no new environment variables or manual migration are required. Leaked keys are recognizable by the `cgsk_` prefix and can be revoked by the group owner.

### Patch Changes

- <a id="v0.3.0-authentication-failures-are-now-logged-server-side-so-an"></a> [#43](https://github.com/hypercerts-org/certified-group-service/pull/43) [`a059e0f`](https://github.com/hypercerts-org/certified-group-service/commit/a059e0fa36f3ecbb44e6e1e4191f5092bc21e3c1) Thanks [@aspiers](https://github.com/aspiers)! - Authentication failures are now logged server-side, so an operator can diagnose a rejected request from the logs instead of having to reproduce it.

  **Affects:** Operators

  **Operators:** every auth rejection in the verifier now emits a `warn`-level log line `"Auth verification failed"` before the request is refused. Previously the fallback error handler returned the error to the client but logged nothing, so a production `401` (e.g. `Invalid audience`) left no server-side trace of who called or which group they targeted.
  - **JWT (service-auth) failures** mostly log `{ reason, nsid, jwt: { header, payload } }`. The JWT is decoded for logging without verifying its signature, and the **signature segment is dropped** — it is a bearer credential and is never written to the logs (`jwt` is `null` for a token that is not a well-formed three-part base64url JWT). The exception is `Missing auth token`, which fires before any token exists and logs only `{ reason, path }`. `reason` is one of: `Missing auth token`, `verifyJwt threw`, `Token lifetime check failed`, `jwt audience does not match service did`, `repo did not resolve to a known group`, `Invalid audience`, `Missing jti`, `Replayed token`.
  - **API-key failures** log `{ reason, authKind: 'apiKey', keyRef, groupDid }` — only the non-secret key reference, never the raw `X-API-Key` value. `reason` is one of: `Malformed API key`, `Missing repo for API-key request`, `repo did not resolve to a known group`, `Invalid API key`, `Corrupt API-key scopes`.
  - No request that previously succeeded is affected, and the HTTP responses returned to clients are unchanged — this is purely additional logging at the existing `logLevel`.

## 0.2.1

### Patch Changes

- Republish the container image. The v0.2.0 image build failed (its version-stamping step had no `.cgs-version` to read), so no `ghcr.io/hypercerts-org/group-service` tags were published for v0.2.0. The publish workflow now stamps the version before building; v0.2.1 is the first release to produce a working image. No functional change to the service versus what v0.2.0 would have shipped.

  **Affects:** Operators

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
