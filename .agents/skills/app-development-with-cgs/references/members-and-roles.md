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
| owner  | + set member/admin roles, propose ownership transfer                                  |

## Constraints (server-enforced — don't fight them)

- **Owner never changes via `role.set`.** Set at register/import; `role.set`
  refuses to promote anyone to owner or modify an existing owner, and
  `member.remove` refuses to remove an owner. Ownership moves only through the
  dedicated `ownershipTransfer.*` handshake (below) or the operator-only
  `admin.setOwner` break-glass endpoint.
- `member.add` / `role.set` assign only `member` or `admin`. Admins can't add at
  or above their own level.
- Any **non-owner** member can **self-remove**; removing others needs admin.
  The owner cannot self-remove — `member.remove` rejects removing an owner
  (`CannotRemoveOwner`); transfer ownership away first.
- **Authorship is immutable** — preserved across `putRecord`. A member edits/deletes
  only records they authored; touching another author's record needs admin
  (`putAnyRecord` / `deleteAnyRecord` in the RBAC layer).
- **Editing the group profile** (`app.bsky.actor.profile`, rkey `self`) always
  requires **admin**, regardless of who created it.

Endpoint signatures:
[integration-guide.md#managing-members-and-roles](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#managing-members-and-roles).

## Ownership transfer (two-phase)

Ownership moves through `app.certified.group.ownershipTransfer.*`, not a role
change. The owner `propose`s an existing member; ownership moves only when that
member `accept`s (their authenticated accept proves they still control their DID
— so a group can't be stranded on a lost account). Either party can `cancel`,
and an un-accepted proposal expires after **7 days**. A group holds at most one
pending proposal.

- `propose` — **owner-only**; target must already be a member (add strangers
  with `member.add` first). Re-proposing the same member **renews** the
  proposal, restarting the 7-day window.
- `accept` — callable **only by the proposed member**; demotes the old owner to
  admin and promotes the caller atomically. **JWT-only**: an API-key request is
  refused with `403 ApiKeyNotPermitted`, and no `rpc:` scope exists to grant it.
  A key outlives its creator's ability to authenticate as their DID, so allowing
  it here would defeat the liveness proof the accept step exists for. Automate
  the rest with a key if you like, but route this step through the user's own
  authenticated session.
- `cancel` — either party (owner revoking, or proposed member declining).
- `status` — a **query**; disclosed **only to the two parties**, deliberately
  not surfaced on `member.list`. A non-party gets the same `pending: false` as
  when no transfer exists — refusing them would itself reveal that one is in
  flight. Same reasoning on `accept`/`cancel`: a non-party gets `404
NoPendingTransfer`, indistinguishable from nothing pending.

`accept`/`cancel`/`status` carry a `member` role floor, but the real gate is an
in-handler identity check — role alone doesn't let a bystander act. Endpoint
shapes and error tables:
[api-reference.md#ownership-transfer](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#ownership-transfer).

## Audit log

`audit.query` is a **query** (`repo` on querystring) and **admin-only**. Every
action — permitted **and denied** — is logged, so it's where "why was this
refused" is answered. Filter by `actorDid`, `action`, `collection`. Action values
and `detail` shapes:
[api-reference.md#audit-log](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#audit-log).
