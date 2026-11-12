---
'group-service': minor
---

API keys holding the matching `rpc:` scope can call `member.add`, `member.remove` and `role.set` again, capped by the issuing member's role; this reverses the 0.6.2 withdrawal.

**Affects:** Client app developers, Operators

**Client app developers:**

- Scopes and the role each method needs: `rpc:app.certified.group.member.add` (admin), `rpc:app.certified.group.member.remove` (admin) and `rpc:app.certified.group.role.set` (owner). The key is capped by its issuing member's current role (scopes ∩ role). Owner immutability and the equal-or-higher-role rules apply to keys exactly as they do to JWT callers.
- Existing `rpc:*` keys gain these methods with no re-issue: an admin-issued `rpc:*` key can now call `member.add` and `member.remove`, and an owner-issued one can call all three. Have group owners review their keys with `app.certified.group.keys.list` and revoke or re-scope any `rpc:*` key that should not manage membership.
- A member-issued `rpc:*` key can now remove the member who issued it (self-removal), a path 0.6.2 had closed. Self-removal skips the role check, as it does for JWT callers, and an owner's key is still refused with `CannotRemoveOwner`.
- A key without the matching scope now gets `403 Forbidden` (`API key scopes do not permit '<operation>'`) instead of `403 ApiKeyNotPermitted`, including for `member.remove` on a non-member target, so it never learns whether the target exists. `ApiKeyNotPermitted` is still returned for `ownershipTransfer.accept`.
- Key callers must put `repo` on the querystring, even for these procedures.
- `member.add`, `member.remove` and `role.set` `permitted` audit entries now carry `apiKeyRef` when the caller is an API key. JWT callers' entries are unchanged.

**Operators:**

- After upgrading, existing `rpc:*` keys in every group gain these methods with no migration or config change, so you may want to tell group owners.
- Docs: see `docs/api-reference.md` (Member management and API key management).
