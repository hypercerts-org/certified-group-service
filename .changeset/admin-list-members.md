---
'group-service': minor
---

Operators can now look up who owns and belongs to a group without being a member of it.

**Affects:** Client app developers, Operators

**Client app developers:** new query `app.certified.group.admin.listMembers`: the same `members` array and `cursor` as `member.list`, owner included. Operator-only; not reachable with a service-auth JWT or an API key. See [Admin operations](docs/api-reference.md#get-xrpcappcertifiedgroupadminlistmembers).

**Operators:** authenticate with HTTP Basic (`admin` / `CGS_ADMIN_PASSWORD`), like `admin.setOwner`. It is read-only and writes no audit entry.
