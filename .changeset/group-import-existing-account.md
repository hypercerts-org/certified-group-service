---
'group-service': minor
---

You can now turn an existing account into a group, instead of always creating a brand-new one.

**Affects:** Client app developers, Operators

**Client app developers:** a new procedure `app.certified.group.import` is the sibling of `app.certified.group.register`. Where `register` creates a new account on the group PDS, `import` reuses an account that already exists.

- Call it directly (like `register`, not via the proxy), with a service-auth JWT (`aud` = the group service DID, `lxm` = `app.certified.group.import`).
- Request body: `{ groupDid, appPassword, ownerDid }`. `groupDid` is the existing account's DID; `appPassword` is an app password for that account so the service can act on its behalf; `ownerDid` must match the JWT `iss` and is seeded as owner. The service resolves the account's PDS and handle from its DID document — no `handle` input.
- Response: `{ groupDid, handle }` (handle resolved from the account).
- Errors: `InvalidRequest` (missing/invalid fields or unresolvable DID), `InvalidAppPassword` (`401` — the app password is wrong/revoked or the account is not on the resolved PDS), `GroupAlreadyRegistered` (`409`).
- Unlike registered groups, the service holds **no recovery key** for an imported account, and `import` does **not** modify the account's DID document. See `docs/integration-guide.md` (Step 1b) and `docs/design/group-import.md`.

**Operators:** `import` is served as a standard XRPC method on `/xrpc/app.certified.group.import` (service-auth, like `register`). No new environment variables. Imported groups are stored in the `groups` table with `encrypted_recovery_key` left `NULL` (the column is already nullable), so they are distinguishable from registered groups, and `PdsAgentPool` drives them via the per-group `pds_url` resolved at import time — which may differ from `GROUP_PDS_URL`.
