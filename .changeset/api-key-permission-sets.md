---
'group-service': minor
---

API keys can now be scoped with an **`include:<nsid>` permission-set scope**. `keys.create` resolves the published permission set (via the standard AT Protocol Lexicon resolution chain — `_lexicon` DNS TXT → authority DID → PDS → `com.atproto.lexicon.schema` record) and expands it into the concrete `repo:` / `rpc:` scopes stored on the key, instead of requiring the owner to enumerate every scope by hand.

**Affects:** Client app developers

- **Use it:** pass `scopes: ['include:org.hypercerts.authWrite']` (or any published permission-set NSID) to `app.certified.group.keys.create`. The returned and stored `scopes` are the **expanded** concrete scopes; the `include:` itself is never stored.
- **Snapshot semantics:** the set is resolved and frozen at key-creation time. A later change to the published set does not affect already-issued keys — re-issue the key to pick it up.
- **Failure:** an `include:` whose set cannot be resolved (no `_lexicon` record, unresolvable authority, non-https PDS, missing record, or a record that is not a `permission-set`) is rejected with `400 InvalidScope`, naming the scope; no partial key is minted.
- **Namespace-agnostic:** the resolver resolves any published set via that set's own namespace authority — CGS has no built-in coupling to specific namespaces.
- Explicitly listing `rpc:` / `repo:` / `blob:` scopes still works exactly as before; `include:` is an additional convenience. Reading records still needs no scope at all (atproto repo records are public).

See `docs/design/api-key-permission-sets.md` (CGS-side) and the [hypercerts-lexicon permission-sets design](https://github.com/hypercerts-org/hypercerts-lexicon/blob/main/docs/design/permission-sets.md) (the sets themselves).
