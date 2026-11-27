---
'@hypercerts-org/certified-group-service': minor
---

Export `com.atproto.server.getServiceAuth` alongside the CGS `app.*` namespace so client apps can mint service-auth tokens from a user's PDS without maintaining a separate local Lexicon build.

**Client app developers:** import `com` from `@hypercerts-org/certified-group-service` and pass `com.atproto.server.getServiceAuth` to your `@atproto/lex` PDS client (`aud`, `lxm`, optional `exp`) to mint single-use bearer tokens for CGS calls. If your app was generating `com.atproto.server.getServiceAuth` locally via `lex install` / `lex build`, you can remove that local codegen step and import it directly from this package. Deprecated `com.atproto.repo.*` proxy stubs remain excluded.
