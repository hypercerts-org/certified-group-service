# @hypercerts-org/certified-group-service

## 0.2.0

### Minor Changes

- [#111](https://github.com/hypercerts-org/certified-group-service/pull/111) [`3df9ac2`](https://github.com/hypercerts-org/certified-group-service/commit/3df9ac243543a1dd89c4a190dd73e761dbb651a7) Thanks [@kristoferlund](https://github.com/kristoferlund)! - Export `com.atproto.server.getServiceAuth` alongside the CGS `app.*` namespace so client apps can mint service-auth tokens from a user's PDS without maintaining a separate local Lexicon build.

  **Client app developers:** import `com` from `@hypercerts-org/certified-group-service` and pass `com.atproto.server.getServiceAuth` to your `@atproto/lex` PDS client (`aud`, `lxm`, optional `exp`) to mint single-use bearer tokens for CGS calls. If your app was generating `com.atproto.server.getServiceAuth` locally via `lex install` / `lex build`, you can remove that local codegen step and import it directly from this package. Deprecated `com.atproto.repo.*` proxy stubs remain excluded.

## 0.1.0

### Minor Changes

- [#107](https://github.com/hypercerts-org/certified-group-service/pull/107) [`fab4bc2`](https://github.com/hypercerts-org/certified-group-service/commit/fab4bc22549610fcfcf22e94be29b66f21c74248) Thanks [@kristoferlund](https://github.com/kristoferlund)! - First release of `@hypercerts-org/certified-group-service`: TypeScript XRPC definitions and types for the Certified Group Service (CGS), for use with the [`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex) client. Every CGS-owned endpoint under `app.certified.group.*` and `app.certified.groups.*` is at its NSID path (`cgs.call(app.certified.groups.membership.list, { limit: 100 })`), with typed parameters, inputs, and outputs. Install it with its peer dependency, `@atproto/lex` `^0.4.2`.
