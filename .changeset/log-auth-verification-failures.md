---
'group-service': patch
---

Authentication failures are now logged server-side, so an operator can diagnose a rejected request from the logs instead of having to reproduce it.

**Affects:** Operators

**Operators:** every auth rejection in the verifier now emits a `warn`-level log line `"Auth verification failed"` before the request is refused. Previously the fallback error handler returned the error to the client but logged nothing, so a production `401` (e.g. `Invalid audience`) left no server-side trace of who called or which group they targeted.

- **JWT (service-auth) failures** mostly log `{ reason, nsid, jwt: { header, payload } }`. The JWT is decoded for logging without verifying its signature, and the **signature segment is dropped** — it is a bearer credential and is never written to the logs (`jwt` is `null` for a token that is not a well-formed three-part base64url JWT). The exception is `Missing auth token`, which fires before any token exists and logs only `{ reason, path }`. `reason` is one of: `Missing auth token`, `verifyJwt threw`, `Token lifetime check failed`, `jwt audience does not match service did`, `repo did not resolve to a known group`, `Invalid audience`, `Missing jti`, `Replayed token`.
- **API-key failures** log `{ reason, authKind: 'apiKey', keyRef, groupDid }` — only the non-secret key reference, never the raw `X-API-Key` value. `reason` is one of: `Malformed API key`, `Missing repo for API-key request`, `repo did not resolve to a known group`, `Invalid API key`, `Corrupt API-key scopes`.
- No request that previously succeeded is affected, and the HTTP responses returned to clients are unchanged — this is purely additional logging at the existing `logLevel`.
