---
'group-service': patch
---

Overlapping ownership changes on the same group can no longer undo one another.

**Affects:** Client app developers, Operators

**Client app developers:** `app.certified.group.ownershipTransfer.propose`, `accept` and `cancel`, and the operator endpoint `app.certified.group.admin.setOwner`, now run one at a time per group. Each validates and writes as a unit, so two requests that arrive together resolve in a defined order instead of one acting on state the other has already replaced. Two responses change in that race: a `propose` that loses the race to `admin.setOwner` is refused with `403` rather than recording a proposal signed by the demoted owner, and a `cancel` whose proposal was replaced while it ran returns `404 NoPendingTransfer` rather than cancelling the replacement. Uncontended requests are unaffected, and no new error codes are introduced.

**Operators:** serialization is per group and in-process, so it holds for one service instance per group database — the arrangement the per-group SQLite files already assume. Running two instances against the same data directory does not serialize these flows.
