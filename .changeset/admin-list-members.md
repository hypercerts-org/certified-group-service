---
'group-service': minor
---

Operators can now look up who owns and belongs to a group without being a member of it.

**Affects:** Client app developers, Operators

**Client app developers:** new query `app.certified.group.admin.listMembers` (`GET /xrpc/app.certified.group.admin.listMembers?repo=<handle-or-did>&limit=&cursor=`). It returns the same `members` array and `cursor` as `member.list`, owner included. It is operator-only and not reachable with a service-auth JWT or an API key.

**Operators:** authenticate with HTTP Basic (`admin` / `CGS_ADMIN_PASSWORD`), like `admin.setOwner`; it returns `401` when `CGS_ADMIN_PASSWORD` is unset. An unknown `repo` returns `404 UnknownGroup`. It is read-only and writes no audit entry.
