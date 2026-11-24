---
'group-service': patch
---

Untracked record writes now need explicit update access to replace an existing record.

**Affects:** End users, Client app developers

**End users:** A `putRecord` request without `putAnyRecord` access is now create-only when the group service has no authorship entry for the key. This can happen after re-import; an existing record will not be replaced by create-only access.

**Client app developers:** Both `com.atproto.repo.putRecord` and `app.certified.group.repo.putRecord` continue to require create access on the untracked-record path. The group service uses `putAnyRecord` only when the caller's role permits it and, for API keys, the key has a matching `repo:<collection>?action=update` scope. Otherwise it sends `swapRecord: null`, overriding any caller-supplied value. See `docs/api-reference.md`.
