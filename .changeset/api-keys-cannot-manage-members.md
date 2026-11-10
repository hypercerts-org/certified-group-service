---
'group-service': patch
---

API keys can no longer add or remove members or change roles, even if the person who created the key is allowed to.

**Affects:** Client app developers

**Client app developers:** `app.certified.group.member.add`, `app.certified.group.member.remove` and `app.certified.group.role.set` now return `403` for any `X-API-Key` caller, whatever scopes the key holds (including `rpc:*`). This was always the intended rule; these three methods previously skipped the key's scope check by mistake. A key can also no longer remove the member who created it. Each denied attempt is written to the audit log with the key's `apiKeyRef`. Make these calls with a service-auth JWT instead.
