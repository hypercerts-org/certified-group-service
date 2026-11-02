---
'group-service': patch
---

Request logs no longer record credential-bearing headers such as `Authorization`, `X-API-Key` and `Cookie`.

**Affects:** Operators

**Operators:**

- Access logs now keep only `host`, `user-agent`, `content-type`, `content-length`, `atproto-proxy` and `x-request-id`. Other headers, including `x-forwarded-for`, are dropped. The client IP is logged as `req.ip`, resolved through the trusted proxy hop; `req.remoteAddress` is the proxy.
- Earlier logs may contain API keys and the `CGS_ADMIN_PASSWORD` Basic credential. If those logs were readable outside trusted operators, rotate both. Service-auth JWTs expire within 120 seconds and need no rotation.
