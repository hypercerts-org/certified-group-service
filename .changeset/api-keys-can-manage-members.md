---
'group-service': minor
---

API keys holding the matching `rpc:` scope can call `member.add`, `member.remove` and `role.set` again, capped by the issuing member's role; this reverses the 0.6.2 withdrawal.

**Affects:** Client app developers, Operators

**Client app developers:**

- A key can call `app.certified.group.member.add`, `app.certified.group.member.remove` and `app.certified.group.role.set` if it holds `rpc:app.certified.group.member.add`, `rpc:app.certified.group.member.remove` or `rpc:app.certified.group.role.set` respectively. The key is capped by its issuing member's current role (scopes ∩ role): `member.add` and `member.remove` need admin, `role.set` needs owner. Owner immutability and the equal-or-higher-role rules apply to keys exactly as they do to JWT callers.
- A key without the matching scope now gets `403 Forbidden` (`API key scopes do not permit '<operation>'`) instead of `403 ApiKeyNotPermitted`, including for `member.remove` on a non-member target, so it never learns whether the target exists. `ApiKeyNotPermitted` is still returned for `ownershipTransfer.accept`.
- A key may remove its own issuer (self-removal) only if it holds the `member.remove` scope. The role check is skipped for self-removal, as it is for JWT callers.
- Key callers must put `repo` on the querystring, even for these procedures.
- `member.add`, `member.remove` and `role.set` `permitted` audit entries now carry `apiKeyRef` when the caller is an API key. JWT callers' entries are unchanged.

**Operators:**

- Existing `rpc:*` keys gain these methods without being reissued. An admin-issued `rpc:*` key can now call `member.add` and `member.remove`. An owner-issued `rpc:*` key can now call all three, including `role.set`.
- Review `app.certified.group.keys.list` and revoke or re-scope any `rpc:*` key that should not manage membership.
- Docs: see `docs/api-reference.md` (Member management and API key management).
