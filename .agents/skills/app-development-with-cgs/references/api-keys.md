# API keys (for backend daemons)

> Read this file when a server must act without a user session. It carries
> when-to-use plus the one gotcha that bites everyone; the full scope grammar,
> rationale, and lifecycle shapes are in `docs/design/api-keys.md` and
> `docs/api-reference.md`.

## When

A user is in the loop → JWT path. A server runs unattended → API key. Any
**group member** can mint a key for themselves; it's a long-lived bearer
credential (`X-API-Key: cgsk_<keyRef>.<secret>`) — no `aud`, no nonce, no
2-minute lifetime. It dies only when revoked.

Lifecycle (JWT-authenticated; a key can never manage keys): `keys.create` —
the caller may only request scopes their **current role** can use (e.g.
`audit.query` needs admin); the plaintext is returned **once** (persist it
immediately). `keys.list` — members see their own keys, owners see all; never
returns the secret. `keys.delete` — members revoke their own keys, owners revoke
any; soft-revoke by `keyRef`, idempotent. The key acts on behalf of the
**member that issued it**, narrowed by its scopes (a member-issued `repo:` key
can only mutate records that member authored; an admin-issued one can touch any).
Scope grammar (`rpc:` / `repo:` / `blob:`), the role-vs-scope axes, and shapes:
[design/api-keys.md](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/api-keys.md)
and
[api-reference.md#api-key-management](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#api-key-management).

## Permission sets (`include:`) — and the API-key caveat

The Hypercerts / Certified record types are published as **permission sets**:
scope bundles named by a single `include:<nsid>` scope —
`org.hypercerts.permissions.crud` (write on all `org.hypercerts.*` collections)
and `app.certified.permissions.crud` (write on all `app.certified.*`). **Two
sets, never one** — a set may only reference its own namespace authority. Reads
need no scope at all.

- **OAuth path (service proxying): usable now.** Request `include:<nsid>` as a
  scope; the user's PDS expands it. No CGS change needed.
- **API-key path: NOT yet implemented.** `keys.create` today accepts only
  `rpc:` / `repo:` / `blob:` — an `include:` scope returns `InvalidScope`.
  Until the planned expansion lands
  ([design/api-key-permission-sets.md](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/api-key-permission-sets.md)),
  list the concrete `repo:org.hypercerts.…?action=…` scopes explicitly. Do
  **not** tell a user an API key can take an `include:` scope yet.

## GOTCHA: API-key requests need `repo` on the QUERYSTRING — even for write procedures

The single most common mistake on the key path, and it differs from the JWT path.
**Structural reason:** a key is verified **against its own group's database** (the
group DID is hashed to locate the per-group store, then the key is checked there),
so the group must be known **before** the key can be authenticated — and auth runs
before the JSON body is parsed. So it reads `repo` from the **querystring only**.
(A JWT verifies by signature, group-independent, so the group can be resolved later
from the body — which is why a JWT `createRecord` may put `repo` only in the body
but an API-key `createRecord` cannot.)

For **any** API-key request (queries _and_ write procedures):

- **Required:** `repo` on the **querystring** (`?repo=<handle-or-did>`).
- Omitting it → `401 Missing repo for API-key request` (thrown at auth, before the
  handler).
- A body `repo` is **not forbidden, just insufficient alone** — if present it must
  resolve to the **same** group as the querystring, else `400`. The key was
  authenticated against the querystring group and can't be redirected via the body.
