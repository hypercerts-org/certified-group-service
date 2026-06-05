---
'group-service': minor
---

A group's owner can now remove the group from the service.

**Affects:** End users, Client app developers, Operators

**End users:** if you are a group's owner, you can now delete the group from the service. This removes the group and its membership from the service only — the underlying account and its data are left untouched, so the account continues to exist and could be added back later. Only the owner can do this; admins and members cannot.

**Client app developers:** a new procedure `app.certified.group.destroy` removes a group from the service.

- Call it directly with a group-scoped service-auth JWT (`aud` = the group's DID, `lxm` = `app.certified.group.destroy`), the same auth style as the other per-group methods.
- The caller must hold the `owner` role (new RBAC operation `group.destroy`, owner-only). Admins and members get `403`.
- No request body — the target group is taken from the JWT audience.
- Response: `{ groupDid }`.
- Errors: `GroupNotFound` (`404`) if the group is not registered.
- It removes the service's record of the group (stored credentials, member index, and per-group database). It does **not** touch the underlying PDS account, so the account can be re-imported afterwards via `app.certified.group.import`.

**Operators:** `destroy` is served on `/xrpc/app.certified.group.destroy`. No new environment variables. On destroy the service deletes the group's row from the `groups` table, deletes its `member_index` entries, and deletes the per-group SQLite file under `data/groups/` (`<sha256(did)>.sqlite`). Global-DB state is removed before the file is unlinked, so an interrupted destroy leaves at worst an orphaned per-group file (harmless; overwritten on re-import) rather than a `groups` row pointing at a missing file. The destroy is recorded in the service log, not in the (deleted) per-group audit log.
