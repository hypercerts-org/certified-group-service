---
'group-service': minor
---

You can now turn an existing account into a group, instead of always creating a brand-new one.

**Affects:** Client app developers, Operators

**Client app developers:** a new procedure `app.certified.group.import` is the sibling of `app.certified.group.register` — it reuses an existing account instead of creating one. You supply the account's app password so the service can act on its behalf, and the JWT must be signed by the account being imported (`iss` = the account's DID), not by the prospective owner. Two consequences worth knowing: the service holds **no recovery key** for an imported account (the owner's own credentials are their credible exit), and `import` does not modify the account's DID document. Full request/response, auth model, and errors are in `docs/integration-guide.md` (Step 1b) and `docs/design/group-import.md`.

**Operators:** `import` is served on `/xrpc/app.certified.group.import` (service-auth, like `register`); no new environment variables. Imported groups are stored in the `groups` table with `encrypted_recovery_key` left `NULL`, distinguishing them from registered groups, and are driven via the per-group `pds_url` resolved at import time — which may differ from `GROUP_PDS_URL`.
