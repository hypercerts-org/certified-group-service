---
'group-service': minor
---

A group's owner can now remove the group from the service.

**Affects:** End users, Client app developers, Operators

**End users:** if you are a group's owner, you can now delete the group from the service. This removes the group and its membership from the service only — the underlying account and its data are left untouched, so the account continues to exist and could be added back later. Only the owner can do this; admins and members cannot.

**Client app developers:** a new procedure `app.certified.group.destroy` removes a group from the service, gated on the `owner` role (new RBAC operation `group.destroy`). It removes only the service's record of the group; the underlying PDS account is left intact, so the account can be re-imported afterwards via `app.certified.group.import`. Call it group-scoped, the same auth style as the other per-group methods. Full request/response and errors are in `docs/api-reference.md` and `docs/integration-guide.md`.

Heads-up: like the other per-group methods, `destroy` currently names the target group via the JWT `aud`. That overload is being deprecated (issue #27) in favour of an explicit request-level group field, with `aud` reverting to the group service's own DID. The `aud` = group DID form will be supported during a transition window and then removed — build against the explicit-group form once it ships.

**Operators:** `destroy` is served on `/xrpc/app.certified.group.destroy`; no new environment variables. It deletes the group's `groups` row and `member_index` entries (in one transaction) and then the per-group SQLite file under `data/groups/`. The destroy is recorded in the service log, not in the (deleted) per-group audit log.
