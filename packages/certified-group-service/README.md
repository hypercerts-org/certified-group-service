# @hypercerts-org/certified-group-service

TypeScript XRPC definitions and types for the Certified Group Service (CGS), for use with [`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex). Install it with its peer dependency:

```sh
npm install @hypercerts-org/certified-group-service @atproto/lex
```

```ts
import { Client } from '@atproto/lex'
import { app, com } from '@hypercerts-org/certified-group-service'

const cgs = new Client('https://groups.certified.app')

const { token: serviceAuthToken } = await pdsClient.call(com.atproto.server.getServiceAuth, {
  aud: 'did:web:groups.certified.app',
  lxm: app.certified.groups.membership.list.main.nsid,
})

const { groups } = await cgs.call(
  app.certified.groups.membership.list,
  { limit: 100 },
  { headers: { authorization: `Bearer ${serviceAuthToken}` } },
)

const { uri, cid } = await cgs.call(
  app.certified.group.repo.putRecord,
  {
    repo: groupDid,
    collection: 'app.certified.actor.profile',
    rkey: 'self',
    record,
    swapRecord: currentCid,
  },
  { headers: { authorization: `Bearer ${serviceAuthToken}` } },
)

type GroupMembership = app.certified.groups.membership.list.GroupMembership
```

## What it contains

The package exports [lex's NSID namespace tree](https://www.npmjs.com/package/@atproto/lex) (`app` and `com`) for every CGS-owned Lexicon under [`lexicons/app/`](../../lexicons/app/) plus `com.atproto.server.getServiceAuth`:

- Group endpoints live under `app.certified.group.*` (`register`, `import`, `destroy`, `repo.*`, `member.*`, `role.set`, `keys.*`, `audit.query`, `ownershipTransfer.*`, `admin.setOwner`).
- Cross-group membership lookup lives at `app.certified.groups.membership.list`.
- Service-auth token minting lives at `com.atproto.server.getServiceAuth` (generated from the upstream AT Protocol Lexicon in [`lexicons/com.atproto.server.getServiceAuth.json`](lexicons/com.atproto.server.getServiceAuth.json)), so consumers can mint CGS service-auth tokens from a user's PDS without running a separate local `lex install` / `lex build` pipeline.
- Deprecated `com.atproto.repo.*` proxy stubs are excluded.

ESM only. `@atproto/lex` is a peer dependency; install a version in the declared range (`^0.4.2`, matching `@hypercerts-org/api` and `@hypercerts-org/lexicon` so consumers share a single `@atproto/lex` installation).

## How it is generated

`pnpm generate` (or `pnpm client:generate` from the repository root) runs `lex build --index-file` over the CGS-owned Lexicons in `../../lexicons/app/`, normalizes import/export ordering so output is deterministic across machines, and writes `src/lexicons/` and `src/index.ts`.

Generated files are committed so Lexicon changes show up in pull request diffs, and `pnpm check:generated` fails when they are stale. Do not edit `src/` by hand.

Regenerate whenever a Lexicon under `lexicons/app/` or the `@atproto/lex` generator version changes.

## Commands

Run from `packages/certified-group-service/`:

| Command              | What it does                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm generate`      | Regenerate `src/` from `../../lexicons/app/`                                                                                       |
| `pnpm check`         | Freshness check, type check, build, and tests                                                                                      |
| `pnpm typecheck`     | Type-check `src/`                                                                                                                  |
| `pnpm build`         | Clean and compile to `dist/` (also runs before `pnpm pack`)                                                                        |
| `pnpm test`          | Build, type-check `test/types.ts` against the built package, and exercise methods through a `Client` with a stubbed `fetch`        |
| `pnpm check:package` | Pack, install the tarball in an empty project outside the workspace, import it in Node, typecheck a consumer, and bundle with Vite |

## Versioning and releases

The package is versioned with Changesets independently of `group-service`. The release workflow publishes it to npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) and provenance, and creates an `@hypercerts-org/certified-group-service@X.Y.Z` tag and GitHub Release when a Release PR that bumps it is merged.

The first release needs a Trusted Publisher for `@hypercerts-org/certified-group-service` on npmjs.com (repository `hypercerts-org/certified-group-service`, workflow `release.yml`). If npm requires the package to exist before one can be configured, an owner of the `@hypercerts-org` npm scope publishes the first version by hand.

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
