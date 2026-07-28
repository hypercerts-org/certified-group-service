---
'group-service': minor
---

A group's owner can now hand ownership to another member, who must accept before it takes effect.

**Affects:** End users, Client app developers

**End users:** once the app you use adds support for it, owning a group lets you transfer ownership to another member yourself instead of asking an operator. You propose them, and ownership only moves once they accept by signing in themselves — so it can't be handed to someone who has lost access to their account. Either of you can cancel before then, and an un-accepted transfer expires after 7 days. Only the two of you can see a transfer in progress.

**Client app developers:**

- Four new methods under `app.certified.group.ownershipTransfer.*`: `propose`, `accept`, `cancel` (procedures) and `status` (query). See [Ownership transfer](../docs/api-reference.md#ownership-transfer) for the contract.
- `propose` is owner-only; `accept` is callable only by the proposed member; `cancel` and `status` by either party. `status` is deliberately not exposed on `member.list` — a non-party gets `403 NotPartyToTransfer`.
- `propose`, `cancel` and `status` accept a service-auth JWT or an API key with the matching `rpc:` scope, subject to the caller's role (so a key can only `propose` if issued by the owner).
- `accept` is **JWT-only**. An API-key request is refused with `403 ApiKeyNotPermitted`, and there is no `rpc:` scope for it — `app.certified.group.ownershipTransfer.accept` cannot be granted to a key, and a wildcard `rpc:*` scope does not cover it. Acceptance is what proves the incoming owner still controls their account, and an API key keeps working after its creator can no longer authenticate as that DID, so a key could otherwise park ownership on an unrecoverable account. Apps that automate group admin with a key must route this one step through the user's own authenticated session.
- A pending proposal is cleared automatically when ownership or a party's membership changes by another route (`admin.setOwner`, `member.remove`, `role.set`), so a stale proposal can never be accepted to revert those changes.
