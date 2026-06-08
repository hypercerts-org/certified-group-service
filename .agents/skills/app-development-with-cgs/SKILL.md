---
name: app-development-with-cgs
description: 'Build AT Protocol apps that read and write group-owned records through the Certified Group Service (CGS). Use when an app needs shared, role-gated control of a single atproto account — registering or importing a group, adding/removing members, setting roles, creating/updating/deleting records in the group''s repo, uploading blobs, querying the audit log, or issuing API keys for a backend daemon. Triggers: "group account", "shared atproto repo", "certified group service", "app.certified.group.*", "atproto-proxy to a group", "X-API-Key cgsk_".'
---

# Building apps on the Certified Group Service

You are an agent writing app code against a **Certified Group Service (CGS)**
deployment. CGS puts role-based access control (owner / admin / member) in front
of a single shared atproto account (the "group"), so several people can write to
one repo without sharing its signing key. This skill is decision-guidance: it
tells you which path to take and where the traps are. It does **not** restate the
full API — the canonical references live in the repo's `docs/` and are linked
inline. Read the linked section before writing the corresponding code; do not
reconstruct request shapes from memory.

> Terminology (match it): "group service" (never "GPDS"), "group's PDS" (never
> "group PDS").

## Canonical references (read these, don't duplicate them)

All URLs point at `main`. They resolve even when this skill is installed on a
machine with no CGS checkout.

- **Integration guide** (the primary how-to, with working TypeScript):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md
- **API reference** (every NSID, request/response shape, error, action values):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md
- **Architecture** (why proxying, where data lives, trust model):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/architecture.md
- **API-key design** (the key framework's rationale and full scope grammar):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/api-keys.md
- **`aud` → `repo` migration (#27)** (the canonical migration walkthrough — read
  this for group targeting):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/aud-migration.md
- **`aud` deprecation design** (rationale: unsigned `repo`, resolution round-trip,
  security analysis):
  https://github.com/hypercerts-org/certified-group-service/blob/main/docs/design/aud-deprecation.md

## Decide first: which auth mode

CGS accepts two credential kinds. Pick before you write anything.

- **Service-auth JWT** (the default). For interactive, user-driven actions where
  a real user's DID is the actor. The JWT is short-lived (≤ 120s, the nonce
  window) and single-use. Almost all app flows use this, via service proxying.
- **API key** (`X-API-Key: cgsk_…`). For a **backend daemon** that must act
  repeatedly without holding a user's signing key or re-minting a JWT every two
  minutes — e.g. syncing membership, or a server repairing records. Owner-issued,
  long-lived, scope-limited. See [API keys](#api-keys-for-backend-daemons) below.

If a human is in the loop and you have their OAuth session, use the JWT path. If
a server runs unattended, use a key.

## The integration shape (JWT path)

Your app is a **backend-for-frontend (BFF)**. You do **not** mint service-auth
JWTs yourself. You send XRPC requests to the _user's_ PDS with an `atproto-proxy`
header; the PDS authenticates the user, mints the service-auth JWT, and forwards
to CGS. CGS then writes to the group's PDS.

```
Your app (BFF) ──proxy header──▶ User's PDS ──service auth──▶ CGS ──▶ Group's PDS
```

Follow the integration guide's Steps 1–3 verbatim for the agent setup
(`agent.withProxy(<serviceId>, <did>)` + loading the custom lexicons). Two things
you must not get wrong:

- **Load the custom lexicons** from `lexicons/app/certified/` into the proxy
  agent, or `@atproto/api` won't know the `app.certified.group.repo.*` NSIDs.
- **Pick the right proxy target.** `withProxy('certified_group_service',
cgsServiceDid)` is the **supported** target — it routes through the _service's_
  own DID document and mints `aud` = the service DID. The older
  `withProxy('certified_group', groupDid)` routes through the _group's_ document
  and mints `aud` = the **group DID** — the deprecated legacy form (see the `aud`
  section below). The two proxy ids are not interchangeable: each names an entry
  in a different DID document.

## CRITICAL: use `app.certified.group.repo.*`, never `com.atproto.repo.*` for writes

For record **writes** (create / put / delete / uploadBlob) use the custom NSIDs:

| Operation   | NSID                                    |
| ----------- | --------------------------------------- |
| Create      | `app.certified.group.repo.createRecord` |
| Update      | `app.certified.group.repo.putRecord`    |
| Delete      | `app.certified.group.repo.deleteRecord` |
| Upload blob | `app.certified.group.repo.uploadBlob`   |

Why this matters and why it is not optional: a PDS handles
`com.atproto.repo.createRecord` **itself** (writes to its own repo) and has no
reason to proxy it anywhere. Only an NSID the PDS doesn't recognise gets looked
up in the group's DID document and proxied to CGS. So a `com.atproto.repo.*`
write **never reaches CGS** through the proxy — it silently lands in the wrong
repo with no RBAC and no audit entry. CGS accepts `com.atproto.repo.*` on
non-proxied calls for backwards-compat only; treat that as legacy.

**Reads are the opposite.** `getRecord` / `listRecords` do **not** go through
CGS — the group's data lives on a real PDS, so use standard
`com.atproto.repo.getRecord` / `listRecords`, which the PDS proxies as reads. No
RBAC, no custom lexicon, no group service involved. Don't route reads through CGS.

See [Custom lexicons](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#custom-lexicons-why-appcertifiedgrouprepo)
and [Reading records](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#reading-records).

## Naming the target group: the `repo` field

Every group-scoped call names its group with an explicit **`repo`** field — an
`at-identifier` (handle **or** DID). Placement depends on method type:

- **JSON-body procedures** (`createRecord`, `putRecord`, `deleteRecord`,
  `member.add`, `member.remove`, `role.set`, `keys.create`, `keys.delete`):
  `repo` goes in the **body**.
- **Queries and raw/body-less methods** (`member.list`, `audit.query`,
  `keys.list`, `repo.uploadBlob`, `group.destroy`): `repo` goes in the
  **querystring** (`?repo=<handle-or-did>`).

A `repo` that names no registered group is rejected with `401 Unknown group`; a
handle that doesn't resolve to a DID at all gives `401 Could not resolve repo to a
DID`. Sending `repo` is exactly what a stock typed `@atproto/api` call already
emits — but `repo` alone is **not** the whole story: it must travel with the
service-DID `aud` (see the `aud` section below), and on the API-key path it must
be on the querystring (see the gotcha further down).

## The `aud` deprecation (#27) — what an agent must do

Historically CGS read the target group from the JWT `aud` claim. That overloaded
`aud` (whose RFC 7519 meaning is _the service receiving the token_) and is now
**deprecated but still accepted**. The two forms:

|                 | Legacy (deprecated)          | New (supported)     |
| --------------- | ---------------------------- | ------------------- |
| Group named by  | JWT `aud`                    | explicit `repo`     |
| JWT `aud`       | the **group** DID            | the **service** DID |
| `repo`          | absent                       | present             |
| Response header | `Deprecation: true` + `Link` | none                |

**`repo` and `aud` change _together_ — never one without the other.** This is the
trap. A request must be _fully_ one form or the other; a half-migrated mix is
**rejected**, not silently downgraded:

- For **queries** (and `uploadBlob` / `destroy`), the verifier sees the
  querystring `repo`, and when `repo` is present it **requires** `aud` = the
  service DID. Sending `repo` with `aud` still the group DID is a hard
  `401 jwt audience does not match service did`. You **cannot** "add `repo` now,
  fix `aud` later".
- For **JSON-body procedures**, the body `repo` is invisible at auth time, so the
  verifier decides purely on `aud`. Set `aud` = the service DID and the call is on
  the supported path (the handler then reads the body `repo`). A group-DID `aud`
  is legacy regardless of any body `repo`.

So the one reliable rule: **mint `aud` = the service DID, and for queries send
`repo` in the same call.**

How you set `aud` depends on the route:

- **Non-proxied:** `getServiceAuth({ aud: cgsServiceDid, lxm })`. You choose `aud`
  directly. Fully migrated.
- **Proxied:** you don't set `aud` — the PDS does, from the DID you proxy to. Use
  `withProxy('certified_group_service', cgsServiceDid)` so the PDS mints `aud` =
  the service DID. The legacy `withProxy('certified_group', groupDid)` mints `aud`
  = the group DID and leaves you on the deprecated path. (The PDS delivers `aud`
  **bare**, `did:web:<host>`; CGS also accepts the `#certified_group_service`
  fragment form.)

**Finding the service DID:** it is not returned by `register`/`import` (they
return the `groupDid`). Resolve the group's DID document, read its
`certified_group` service entry for the service URL, then derive
`did:web:<host>`. Caveat: right after `register` the group's DID document may
still be cached without that entry — retry with a forced refresh if it's missing.

**Watch for `Deprecation: true`** on responses to spot un-migrated calls in an
existing codebase. Full walkthrough (per-method `repo` placement, service-DID
derivation, proxied vs non-proxied):
[aud-migration.md](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/aud-migration.md).

## Creating a group: register vs import

Both are **service-scoped** (`aud` = the service DID) and take no `repo` — they
don't act on an existing group (`register` creates one, `import` adopts one). The
guide invokes them **non-proxied** (the client calls CGS directly), the simplest
way to reach a service-scoped method; they can also be proxied to the service DID.

- **`app.certified.group.register`** — provisions a _fresh_ account on the
  group's PDS and seeds the owner. The JWT must be signed by the prospective
  owner; `iss` must equal `ownerDid`. CGS holds a recovery key for the new
  account (credible exit).
- **`app.certified.group.import`** — promotes an _existing_ atproto account to a
  group, reusing its DID/handle/repo. The JWT must be signed by **the account
  being imported** (the grantor), not the owner — an app password alone can't
  produce that signature, so you need an authenticated session for that account
  plus an app password it can revoke later. `ownerDid` is _not_ separately
  authenticated and may differ from the imported account, so validate it
  client-side before importing.

Choose `import` only when the account already exists and the user wants to keep
its DID/history; otherwise `register`. Full parameters and the register/import
differences: [Step 1 / Step 1b](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#step-1-register-a-group).

## Members, roles, and what each role may do

Roles are **per-group**, not global: a user can be owner of one group and a plain
member of another. Every permission check is scoped to the group named by `repo`.

| Role   | May do (within that group)                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| member | create records, edit/delete **own** records, upload blobs, list members                                           |
| admin  | the above + edit/delete **any** member's records, edit the group profile, add/remove members, query the audit log |
| owner  | the above + set member/admin roles                                                                                |

Constraints you will hit (don't fight them — they're enforced server-side):

- **Owner is immutable.** Set only at `register`/`import`. `role.set` refuses to
  promote anyone to owner or to modify an existing owner; `member.remove` refuses
  to remove an owner. Ownership transfer is not yet implemented.
- `member.add` and `role.set` can assign only `member` or `admin`. Admins can't
  add at or above their own level.
- Any member can remove **themselves** (self-removal); removing others needs
  admin.
- **Record authorship is immutable.** The original author is preserved across
  `putRecord`. A member may edit/delete only records they authored; touching
  another author's record needs admin (surfaced as the `putAnyRecord` /
  `deleteAnyRecord` operations in the RBAC layer).
- **Editing the group profile** (`app.bsky.actor.profile`, rkey `self`) always
  requires **admin**, regardless of who created it.

Endpoint signatures (NSIDs, bodies, responses):
[Managing members and roles](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#managing-members-and-roles).
Role rules in full:
[Role quick reference](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#role-quick-reference).

## Audit log

Every action — permitted **and** denied — is logged. `audit.query` is a query
(so `repo` is on the querystring) and is **admin-only**. Filter by `actorDid`,
`action`, or `collection`. If you're debugging "why was this refused", the audit
log is the answer; the denial is recorded there too. Action values and `detail`
shapes:
[api-reference.md#action-values](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#action-values).

## Removing a group

`app.certified.group.destroy` (owner-only, `repo` on the querystring) is the
service-level inverse of register/import: it drops CGS's stored credentials,
membership, and per-group data. It deliberately does **not** delete the
underlying PDS account — the DID/handle/repo persist and the account can be
re-imported later. Destroy is _not_ account deletion; tear the account down
separately if that's the intent. Because the per-group DB (including its audit
log) is dropped, the destroy isn't in the group's audit log — only the service's
operational log.

## Listing a user's groups (cross-group)

`app.certified.groups.membership.list` (note the **plural** `groups`) is
**service-level**, not group-scoped: it lists every group the authenticated user
belongs to. The JWT `aud` must be the **service DID** and there is no `repo` (it
isn't about one group). Any authenticated user can list their own memberships.
Use this for "which groups am I in" UI. Details:
[Cross-group queries](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#cross-group-queries).

## API keys (for backend daemons)

When a server must act without a user session, an **owner** mints an API key. A
key is a long-lived bearer credential — store it once, send it as
`X-API-Key: cgsk_<keyRef>.<secret>` on each request. No `aud`, no nonce, no
2-minute lifetime. It dies only when revoked.

**Lifecycle (all owner-only, all authenticated with a normal owner JWT — a key
can never manage keys):**

- `app.certified.group.keys.create` — `{ repo, name, scopes }`. The plaintext
  `key` is returned **exactly once**; persist it immediately, it's never
  retrievable again.
- `app.certified.group.keys.list` — never returns the secret or its hash.
- `app.certified.group.keys.delete` — soft-revoke by `keyRef`; rejected on next
  use. Idempotent.

**Scopes** (granted at create time, from `@atproto/oauth-scopes`):

| kind    | form                                                                  | grants                                               |
| ------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `rpc:`  | `rpc:<method>` (friendly, e.g. `rpc:app.certified.group.member.list`) | a service read method (`member.list`, `audit.query`) |
| `repo:` | `repo:<collection>?action=create\|update\|delete`                     | a PDS-repo write on that collection                  |
| `blob:` | `blob:<accept>` (e.g. `blob:image/*`, `blob:*/*`)                     | `uploadBlob` of a matching content type              |

For `rpc:` scopes pass the **friendly** `rpc:<method>` name — do **not** add an
`aud`; the service binds each scope to its own audience before storing and echoes
back the canonical form. `InvalidScope` is returned for an unparseable scope, a
non-RPC method, or an `aud` for a different service.

**Two authorization axes apply to every key request:**

1. **Scope** — does the key's scope set cover this operation? Outside scope →
   `403`.
2. **Role** — the key acts on behalf of the **owner that issued it**, narrowed
   by its scopes. A `repo:` write key has _no own-vs-any axis_: the issuing
   role still decides whose records may be touched (a member-issued key can only
   mutate records that member authored; an admin-issued key can touch any).

### GOTCHA: API-key requests need `repo` on the QUERYSTRING — even for write procedures

This is the single most common mistake on the key path, and it differs from the
JWT path. The reason is structural, not cosmetic: an API key is verified
**against its own group's database** (the group DID is hashed to locate the
per-group store, then the key is checked there), so the group must be known
**before** the key can be authenticated. Group resolution is therefore a
_precondition_ of auth, and the auth layer runs before the JSON body is parsed —
so it reads `repo` from the **querystring only**.

Contrast with the JWT path: a JWT verifies by _signature_, independent of which
group, so the group can be resolved later, in the handler, from the **body**
`repo`. That's why a JWT `createRecord` can put `repo` only in the body — but an
API-key `createRecord` cannot.

Concretely, for **any** API-key request (queries _and_ write procedures):

- **Required:** `repo` on the **querystring** (`?repo=<handle-or-did>`).
- Omitting it → `401 Missing repo for API-key request` (thrown at auth, before
  the handler runs).
- A body `repo` is **not forbidden, just insufficient on its own** — if you send
  one (e.g. because the lexicon/standard client includes it), it must resolve to
  the **same** group as the querystring, or the request is rejected (`400`). The
  key was authenticated against the querystring group and can't be redirected to
  another via the body.

Full grammar, examples, and the scope registry:
[Authenticating with an API key](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#authenticating-with-an-api-key)
and
[API key management](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/api-reference.md#api-key-management).

## Errors you'll see and what they mean

Standard XRPC `{ "error": "...", "message": "..." }`. The ones specific to CGS
decisions:

- `401 Unknown group` — `repo` named no registered group. Check the handle/DID.
- `401 Could not resolve repo to a DID` — the `repo` handle doesn't resolve at
  all (vs. resolves but isn't a registered group).
- `401 Missing repo for API-key request` — you forgot querystring `repo` on a key
  request.
- `403 Forbidden` — the caller's role (or the key's scope) doesn't permit the
  operation. Cross-check against the role table above; the denial is in the audit
  log.
- `Deprecation: true` response header — you're on the legacy `aud` targeting.
  Move to the service-DID `aud` (proxied: target `certified_group_service`;
  non-proxied: `getServiceAuth({ aud: cgsServiceDid })`) **and** send `repo`. Both
  together — not `repo` alone.
- `401 jwt audience does not match service did` — half-migrated: you sent `repo`
  (on a query) but `aud` is still the group DID. Set `aud` to the service DID.

General error table:
[Error handling](https://github.com/hypercerts-org/certified-group-service/blob/main/docs/integration-guide.md#error-handling).

## Reference implementation to copy from

The repo's `demo/` app is a complete, working BFF: OAuth login, proxy-agent
creation with custom lexicons, the proxy route, and group registration. When in
doubt about wiring, read it rather than guessing:
https://github.com/hypercerts-org/certified-group-service/tree/main/demo
