---
'group-service': patch
---

API keys can no longer call `member.add`, `member.remove` or `role.set`. This capability is withdrawn, and there is no long-lived replacement.

**Affects:** Client app developers

**Client app developers:** `app.certified.group.member.add`, `app.certified.group.member.remove` and `app.certified.group.role.set` now return `403 ApiKeyNotPermitted` for any `X-API-Key` caller, whatever scopes the key holds (including `rpc:*`). Keys were never meant to manage membership; these three methods skipped the key's scope check by mistake. That gap also let any key remove the member who created it through the self-removal path, which is now closed. Each refused call is written to the audit log with the key's `apiKeyRef`. Automation that managed members with an API key must switch to a per-request service-auth JWT signed by a member with the required role.
