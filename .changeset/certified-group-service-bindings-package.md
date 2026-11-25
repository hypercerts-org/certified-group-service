---
'@hypercerts-org/certified-group-service': minor
---

First release of `@hypercerts-org/certified-group-service`: TypeScript XRPC definitions and types for the Certified Group Service (CGS), for use with the [`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex) client. Every CGS-owned endpoint under `app.certified.group.*` and `app.certified.groups.*` is at its NSID path (`cgs.call(app.certified.groups.membership.list, { limit: 100 })`), with typed parameters, inputs, and outputs. Install it with its peer dependency, `@atproto/lex` `^0.4.2`.
