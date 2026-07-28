---
'group-service': minor
---

An API key requesting "everything I'm allowed to do" is no longer refused for members and admins.

**Affects:** Client app developers

**Client app developers:**

- `keys.create` no longer rejects a wildcard `rpc:*` scope on the basis of the creator's role. Previously the wildcard was expanded to every key-accessible operation and each was role-checked, so the whole request failed if any single one outranked the caller — in practice `rpc:*` was refused for members (blocked by the admin-only `audit.query`) and, once ownership transfer added the owner-only `ownershipTransfer.propose`, for admins too.
- A wildcard now always passes creation and grants whatever the issuing member's role permits **at request time**. A member's `rpc:*` key can call `member.list` but is still refused `audit.query` with a `403`; the cap follows the issuer's current role, so promotion or demotion widens or narrows an existing key with no re-issue.
- Enumerated scopes are unchanged: naming an operation your role cannot use is still rejected at creation with `role '<role>' cannot use scope for '<operation>'`. The fail-fast behaviour applies where you made a specific claim, not where you asked for whatever is available.
- No key gains access it did not have before. Request-time RBAC was always the enforcement point; this only stops refusing to mint keys that would have been correctly capped anyway.
