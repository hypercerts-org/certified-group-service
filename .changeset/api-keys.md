---
'group-service': minor
---

Owners can now issue long-lived, scope-limited **API keys** so a backend can call the group service without holding the owner's signing key or minting a fresh service-auth JWT every two minutes.

**Affects:** Client app developers, Operators

**Client app developers:** three new owner-only XRPC methods manage keys, and group-scoped read **and write** methods now accept key auth.

- **Mint a key:** `app.certified.group.keys.create` (owner-only, JWT-authed) with `{ repo, name, scopes }`. Returns the full plaintext key (`cgsk_<keyRef>.<secret>`) **exactly once** — store it then; it is never retrievable again. Invalid scope strings are rejected with `InvalidScope`.
- **List / revoke:** `app.certified.group.keys.list` (paginated; `includeRevoked` to show revoked keys; never returns the secret or its hash) and `app.certified.group.keys.delete` (`{ repo, keyRef }`, soft-delete — the key is rejected on its next use).
- **Supported scopes:** reads — `rpc:app.certified.group.member.list`, `rpc:app.certified.group.audit.query`; PDS-repo writes — `repo:<collection>?action=create|update|delete` (createRecord / putRecord / deleteRecord); blob uploads — `blob:<accept>` (e.g. `blob:image/*`). Pass `rpc:` and `repo:` scopes by their friendly name — the service binds the audience for you.
- **Use a key:** send `X-API-Key: cgsk_…` instead of `Authorization: Bearer <jwt>`, and name the group with `repo` on the **querystring** — including for write procedures, since API-key auth resolves the group before the JSON body is parsed. (If a procedure body also carries `repo`, it must resolve to the same group, else `400`.) No nonce, no 2-minute lifetime; the key is valid until revoked.
- **Authorization:** a key is constrained by **both** its scopes **and** the role of the owner that minted it (`effective = scopes ∩ role-perms`). A key can never reach an operation outside its scopes (e.g. a read-only key gets `403` on a write) and never mint or revoke keys. For record writes, the scope says which collection + action; the role check still decides _whose_ records — `repo:` scopes have no own-vs-any axis, so a member-issued key can only mutate records that member authored. Key-driven actions are attributed in the audit log by `apiKeyRef`.
- **Scopes** use [`@atproto/oauth-scopes`](https://www.npmjs.com/package/@atproto/oauth-scopes). The `rpc:` scope `aud` is the service ref `did:web:<host>#certified_group_service`, which `keys.create` builds from the declared scope; `repo:`/`blob:` scopes carry no `aud` and are stored as given.

**Operators:** no new environment variables and no manual migration (a per-group `group_api_keys` table is created automatically). The service now serves its **`did:web` document** at `GET /.well-known/did.json` (previously a 404), publishing a `#certified_group_service` service entry so the service DID resolves and the api-key scope `aud` is backed by a real entry. The JWT-auth `aud` check is unchanged and remains bare-DID tolerant. A leaked key is recognisable by its `cgsk_` prefix and revocable via `keys.delete`. See `docs/design/api-keys.md`.
