# @hypercerts-org/certified-group-service

## 0.1.0

### Minor Changes

- [#107](https://github.com/hypercerts-org/certified-group-service/pull/107) [`fab4bc2`](https://github.com/hypercerts-org/certified-group-service/commit/fab4bc22549610fcfcf22e94be29b66f21c74248) Thanks [@kristoferlund](https://github.com/kristoferlund)! - First release of `@hypercerts-org/certified-group-service`: TypeScript XRPC definitions and types for the Certified Group Service (CGS), for use with the [`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex) client. Every CGS-owned endpoint under `app.certified.group.*` and `app.certified.groups.*` is at its NSID path (`cgs.call(app.certified.groups.membership.list, { limit: 100 })`), with typed parameters, inputs, and outputs. Install it with its peer dependency, `@atproto/lex` `^0.4.2`.
