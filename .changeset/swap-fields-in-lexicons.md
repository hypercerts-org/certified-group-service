---
'group-service': minor
---

`app.certified.group.repo.{createRecord,putRecord,deleteRecord}` now declare the optional compare-and-swap fields `swapRecord` / `swapCommit` and the `InvalidSwap` error in their lexicons.

**Affects:** Client app developers

**Client app developers:**

- Fields: `createRecord` takes `swapCommit`; `putRecord` takes `swapRecord` (a CID, or `null` for create-only) and `swapCommit`; `deleteRecord` takes `swapRecord` and `swapCommit`.
- These were already forwarded to the group's PDS and enforced there; the service now declares them. A stale value returns `400 InvalidSwap` and nothing is written.
- A swap value that is not a valid CID is now rejected with `400 InvalidRequest` by the service before reaching the PDS (previously by the PDS).
- `swapCommit` is repo-wide, so any other member's write makes it stale; use `swapRecord` for per-record checks.
- Docs: see `docs/api-reference.md` (Record operations).
