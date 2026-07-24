---
'group-service': minor
---

Members can transfer group ownership through a new two-phase, accept-to-confirm flow.

**Affects:** Client app developers, Members

Previously the sole owner of a group could not hand ownership to another member —
`role.set` rejects promoting to or changing the owner role, and the only way to
reassign an owner was the operator-only `admin.setOwner` break-glass endpoint.
This adds a member-facing flow so an owner can transfer ownership without
operator involvement.

Four new XRPC methods under `app.certified.group.ownershipTransfer.*`:

- **`propose`** (owner-only) — propose an existing member as the new owner.
  Ownership does not move yet; a pending proposal is recorded.
- **`accept`** (proposed owner only) — accept and become owner. The previous
  owner is demoted to admin atomically. Requiring the proposed owner to accept
  proves they still control their DID, so a group can't be stranded by handing
  ownership to an account whose keys are lost.
- **`cancel`** (owner or proposed owner) — abandon a pending proposal.
- **`status`** (owner or proposed owner) — read the pending transfer. It is
  visible only to the two parties, not on `member.list`.

A group holds at most one pending proposal, and a proposal lapses if it is not
accepted within **7 days**. All four methods are JWT-authenticated and also
reachable with an [API key](docs/api-reference.md#authenticating-with-an-api-key)
carrying the matching `rpc:` scope (subject to the caller's role).

A pending proposal is invalidated automatically whenever ownership or a party's
membership changes by another route — `admin.setOwner`, `member.remove`, or
`role.set` on a party all clear it — so a stale proposal can never be accepted
later to revert those changes.

See [Ownership transfer](docs/api-reference.md#ownership-transfer) in the API
reference. The operator-only `admin.setOwner` endpoint remains the recovery path
when the incumbent owner is unavailable (and now clears any pending transfer).
