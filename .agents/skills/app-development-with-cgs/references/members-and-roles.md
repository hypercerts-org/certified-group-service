# Members, roles, and the audit log

> Read this file when adding/removing members, setting roles, or reading the
> audit log. It carries the role model and the constraints you'll hit; endpoint
> shapes are in `docs/integration-guide.md` and `docs/api-reference.md`.

## Roles are per-group (a user can be owner of one, member of another)

Every check is scoped to the group named by `repo`.

| Role   | May do (within that group)                                                            |
| ------ | ------------------------------------------------------------------------------------- |
| member | create records, edit/delete **own** records, upload blobs, list members               |
| admin  | + edit/delete **any** member's records, edit group profile, add/remove members, audit |
| owner  | + set member/admin roles                                                              |

## Constraints (server-enforced — don't fight them)

- **Owner is immutable.** Set only at register/import. `role.set` refuses to
  promote anyone to owner or modify an existing owner; `member.remove` refuses to
  remove an owner. Ownership transfer is not yet implemented.
- `member.add` / `role.set` assign only `member` or `admin`. Admins can't add at
  or above their own level.
- Any member can **self-remove**; removing others needs admin.
- **Authorship is immutable** — preserved across `putRecord`. A member edits/deletes
  only records they authored; touching another author's record needs admin
  (`putAnyRecord` / `deleteAnyRecord` in the RBAC layer).
- **Editing the group profile** (`app.bsky.actor.profile`, rkey `self`) always
  requires **admin**, regardless of who created it.

Endpoint signatures:
[integration-guide.md#managing-members-and-roles](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#managing-members-and-roles).

## Audit log

`audit.query` is a **query** (`repo` on querystring) and **admin-only**. Every
action — permitted **and denied** — is logged, so it's where "why was this
refused" is answered. Filter by `actorDid`, `action`, `collection`. Action values
and `detail` shapes:
[api-reference.md#audit-log](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#audit-log).
