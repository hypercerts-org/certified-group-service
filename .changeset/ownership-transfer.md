---
'group-service': minor
---

A group's owner can now hand ownership to another member, who must accept before it takes effect.

**Affects:** End users, Client app developers

**End users:** if you own a group, you can transfer ownership to another member instead of asking an operator to do it. You propose them, and ownership only moves once they accept — so it can't be handed to someone who has lost access to their account. Either of you can cancel before then, and an un-accepted transfer expires after 7 days. Only the two of you can see a transfer in progress.

**Client app developers:**

- Four new methods under `app.certified.group.ownershipTransfer.*`: `propose`, `accept`, `cancel` (procedures) and `status` (query). See [Ownership transfer](../docs/api-reference.md#ownership-transfer) for the contract.
- `propose` is owner-only; `accept` is callable only by the proposed member; `cancel` and `status` by either party. `status` is deliberately not exposed on `member.list` — a non-party gets `403 NotPartyToTransfer`.
- All four accept a service-auth JWT or an API key with the matching `rpc:` scope, subject to the caller's role (so a key can only `propose` if issued by the owner).
- A pending proposal is cleared automatically when ownership or a party's membership changes by another route (`admin.setOwner`, `member.remove`, `role.set`), so a stale proposal can never be accepted to revert those changes.
