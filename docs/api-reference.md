# API Reference

All endpoints (except `/health` and `/xrpc/_health`) require authentication. The primary mode is a signed service-auth **JWT** in the `Authorization: Bearer <token>` header (below); group-scoped read and write methods additionally accept a long-lived, scope-limited **API key** in the `X-API-Key` header (see [Authenticating with an API key](#authenticating-with-an-api-key)). The JWT must include:

- `iss` — the caller's DID
- `aud` — the **service DID** (its standard RFC 7519 meaning: the audience is the service receiving the request)
- `lxm` — the XRPC method being called
- `jti` — a unique nonce (each token can only be used once)
- `exp` — expiration timestamp

## Two ways to send a request

A client reaches the service by one of two routes, referred to throughout this reference:

- **Non-proxied call** — the client fetches a service-auth token from the user's PDS (`com.atproto.server.getServiceAuth`), then sends the XRPC request to the group service itself with that token in the `Authorization` header. The client chooses the `aud` it requests.
- **Proxied call** — the client sends the request to the user's PDS with an `atproto-proxy` header; the PDS forwards it to the group service. The PDS chooses `aud` (the DID being proxied to), not the client. This is the standard AT Protocol pattern.

The user's PDS signs the token in **both** cases; the routes differ in who chooses `aud` and who sends the final request to the group service.

## Determining the service DID

The service DID — the value of `aud` — is found in two steps:

1. **Find the service URL.** A group's DID document carries a `certified_group` service entry whose `serviceEndpoint` is the service URL. Resolve the `groupDid` and read that entry. This is the only on-protocol link from a group to the service hosting it (`register` / `import` return the `groupDid`, not the service DID). **Caution:** immediately after `register`, a freshly created group's DID document may still be cached (by your resolver or an intermediary PDS) in its initial form, before the `certified_group` entry was added — so the entry can be transiently absent. If it is missing right after registration, retry with a forced refresh / after a short delay rather than treating the group as having no service.
2. **Derive the service DID** from that URL's host: a `did:web` formed by stripping the scheme — `https://group-service.example.com` → `did:web:group-service.example.com`. This is pure string manipulation, no further lookup.

A **non-proxied** call sets this value as the JWT `aud` directly. On a **proxied** call the client never sets `aud` itself — the PDS does — so the value is supplied differently; see [How `aud` is set on a proxied call](#how-aud-is-set-on-a-proxied-call).

## How `aud` is set on a proxied call

On a proxied call the PDS sets `aud` to **the DID in the `atproto-proxy` header** (`<did>#<service-id>`), then resolves that DID's document and forwards to its service endpoint. So the client controls `aud` only by choosing which DID it proxies to:

- **Proxy to the service DID** (`atproto-proxy: <serviceDid>#certified_group_service`): the PDS resolves the service's own `did:web` document at `/.well-known/did.json`, forwards, and mints `aud` = the service DID. This is the supported form.
- **Proxy to the group DID** (`atproto-proxy: <groupDid>#certified_group`): the PDS resolves the group's document and mints `aud` = the group DID — the deprecated legacy form (see [Legacy `aud` = group DID form](#legacy-aud--group-did-form-deprecated)).

The two service ids differ because they live in different documents: `certified_group_service` is the entry in the **service's** `did:web` document; `certified_group` is the entry in a **group's** document.

Either way the PDS delivers `aud` **bare** (`did:web:<host>`, no fragment). The service also accepts the fragment-qualified `did:web:<host>#certified_group_service` for forward-compatibility (some PDS versions will stop stripping the fragment), and rejects a fragment naming a different service.

## Targeting a group

Group-scoped methods name their target group with an explicit `repo` field — an `at-identifier` (a handle **or** a DID), resolved to the group DID server-side. The JWT `aud` is the service DID. Where `repo` goes depends on the method kind:

- **Query methods** (`member.list`, `audit.query`) and **raw-body / body-less methods** (`repo.uploadBlob`, `group.destroy`) read `repo` from the **querystring** (`?repo=<handle-or-did>`).
- **JSON-body procedures** (`createRecord`, `putRecord`, `deleteRecord`, `member.add`, `member.remove`, `role.set`) read `repo` from the request **body**.

`repo` is the group selector itself; the service enforces authorization per-group via RBAC (membership/role), so a caller can only act on groups they already hold a role in. A `repo` that names no registered group is rejected with `401 Unknown group`; a handle that does not resolve is rejected with `401 Could not resolve repo to a DID`. The `repo` value is **not** covered by the JWT signature — the service-auth JWT signs only `iss`/`aud`/`exp`/`lxm`/`jti`, matching standard atproto, which never signs the resource. See `docs/design/aud-deprecation.md` for the security rationale.

Cross-group endpoints under `app.certified.groups.*` and the group-lifecycle methods `register` / `import` target the service itself (`aud` = service DID) and take no `repo`.

## Legacy `aud` = group DID form (deprecated)

A transitional form remains accepted during the migration window: set the JWT `aud` to the **group DID** (omitting `repo`). This is **deprecated** (issue [#27](https://github.com/hypercerts-org/certified-group-service/issues/27)) and will be removed in a later release once clients migrate.

|                    | Legacy (deprecated)          | New (supported)     |
| ------------------ | ---------------------------- | ------------------- |
| Group named by     | JWT `aud`                    | explicit `repo`     |
| JWT `aud`          | the **group** DID            | the **service** DID |
| `repo` field       | absent                       | present             |
| Deprecation header | `Deprecation: true` + `Link` | none                |

`repo` and the service-DID `aud` change **together**: for a query, sending `repo` with `aud` = a group DID is rejected with `jwt audience does not match service did` — there is no half-migrated state. Responses on the legacy path carry RFC 8594 headers (`Deprecation: true` + a `Link`); no `Sunset` date is set yet.

For the full migration walkthrough (per-method `repo` placement, direct vs proxied, detecting un-migrated calls) see [`aud-migration.md`](./aud-migration.md); for the design rationale see [`design/aud-deprecation.md`](./design/aud-deprecation.md).

## Authenticating with an API key

As an alternative to a per-request service-auth JWT, an owner can issue a long-lived **API key** (see [API key management](#api-key-management)). A backend authenticates by sending the key in the `X-API-Key` header instead of `Authorization: Bearer`:

```text
X-API-Key: cgsk_<keyRef>.<secret>
```

The group is named with `repo` on the **querystring** (`?repo=<handle-or-did>`). Unlike the JWT path, an API-key request must put `repo` on the querystring **even for procedures** (e.g. record writes): API-key auth resolves and authenticates against the group before the JSON body is parsed, so a body `repo` is invisible at authentication time. Omitting the querystring `repo` is rejected with `401 Missing repo for API-key request`. If a procedure body _also_ carries a `repo`, it must resolve to the same group as the querystring — a mismatch is rejected (`400`), since the key was authenticated against the querystring group and cannot be redirected to another. There is no `aud`, no nonce, and no 2-minute lifetime: the key is valid until revoked. A key is constrained by its granted **scopes** _and_ by the role of the owner that issued it; a request outside the key's scopes is rejected with `403`.

```bash
curl "https://group-service.example.com/xrpc/app.certified.group.member.list?repo=did:plc:group123" \
  -H "X-API-Key: cgsk_ab12cd34.Zlen…"
```

## Health check

### `GET /health` / `GET /xrpc/_health`

Returns service health status. No authentication required. Both paths return
the identical body; `/xrpc/_health` exists for parity with the upstream PDS
convention.

**Response:**

```
200 OK
```

```json
{ "status": "ok", "service": "group-service", "version": "0.1.0+90d10b96" }
```

The `version` is resolved from the `CGS_VERSION` env var, a build-time
`.cgs-version` file, or `package.json` (in that order). When the global
database is unreachable, both endpoints return `503` with
`{ "status": "error", "message": "database unreachable" }`.

---

## Group lifecycle

These procedures create, import, and remove groups. `register` and `import` are **service-scoped**: they target the service itself (JWT `aud` = the service DID) and take no `repo`, because they are not acting on an existing group — `register` creates one, `import` adopts one. The examples below show them as non-proxied calls, which is the simplest way to invoke a service-scoped method; they could also be reached by proxying to the service DID (`certified_group_service`), since that does not depend on a group existing. `destroy` operates on an existing group.

### `POST /xrpc/app.certified.group.register`

Create a new group: provision a fresh account on the group's PDS and seed the caller-named owner.

**Authentication:** service-level (JWT `aud` = service DID). The JWT `iss` must equal `ownerDid`.

**Request body:**

```json
{
  "handle": "mygroup",
  "ownerDid": "did:plc:owner123",
  "email": "owner@example.com"
}
```

`handle` is the short name (combined with the PDS hostname to form the full handle); `ownerDid` is seeded as the immutable owner and must match the JWT `iss`; `email` is optional (a recovery email enabling the forgot-password flow for credible exit).

**Response (200):**

```json
{
  "groupDid": "did:plc:group123",
  "handle": "mygroup.pds.example.com",
  "accountPassword": "generated-primary-password"
}
```

The owner must save `accountPassword` — it is the group account's primary credential for credible exit.

**Errors:**

| Code | Name                   | Description                                   |
| ---- | ---------------------- | --------------------------------------------- |
| 400  | InvalidRequest         | Missing/invalid fields                        |
| 401  | AuthenticationRequired | Missing or invalid JWT, or `iss` ≠ `ownerDid` |
| 409  | HandleNotAvailable     | The handle is already taken                   |
| 409  | GroupAlreadyRegistered | A group already exists for this account       |

### `POST /xrpc/app.certified.group.import`

Promote an **existing** PDS account into a group (the sibling of `register`, reusing an account rather than creating one).

**Authentication:** service-level (JWT `aud` = service DID). The JWT `iss` must equal `groupDid` — the account being imported signs the request; the prospective owner does not. An app password cannot mint such a JWT, so this proves control of the account beyond merely holding its app password. See `docs/design/group-import.md` (the "Auth model" decision) for the rationale.

**Request body:**

```json
{
  "groupDid": "did:plc:existing123",
  "appPassword": "abcd-efgh-ijkl-mnop",
  "ownerDid": "did:plc:owner123"
}
```

`groupDid` is the existing account's DID; `appPassword` is an app password for it, stored encrypted so the service can act on its behalf; `ownerDid` is seeded as owner. `ownerDid` is **not** separately authenticated and may differ from `groupDid`. The service resolves the account's PDS (which must be `https`) and handle from its DID document — there is no `handle` input.

**Response (200):**

```json
{
  "groupDid": "did:plc:existing123",
  "handle": "existing.pds.example.com"
}
```

**Errors:**

| Code | Name                   | Description                                                              |
| ---- | ---------------------- | ------------------------------------------------------------------------ |
| 400  | InvalidRequest         | Missing/invalid fields, unresolvable DID, or a non-`https` PDS endpoint  |
| 401  | AuthenticationRequired | Missing/invalid JWT, or `iss` ≠ `groupDid`                               |
| 401  | InvalidAppPassword     | App password is wrong/revoked, or the account is not on the resolved PDS |
| 409  | GroupAlreadyRegistered | A group already exists for this account                                  |

Unlike registered groups, the service holds **no recovery key** for an imported account (the owner's own credentials are their credible exit), and `import` does not modify the account's DID document.

### `POST /xrpc/app.certified.group.destroy`

Remove the group from the service.

**Required role:** owner

The service-level inverse of `register` / `import`: it removes the group's stored credentials, membership, and per-group data. It does **not** delete the underlying PDS account — the DID, handle, and repo continue to exist, so the account can be re-imported afterwards with `app.certified.group.import`.

**Request body:** none. The target group is named by the `repo` querystring parameter (`?repo=<handle-or-did>`), with JWT `aud` = service DID.

> The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Response (200):**

```json
{
  "groupDid": "did:plc:group1"
}
```

**Errors:**

| Code | Name                   | Description                                            |
| ---- | ---------------------- | ------------------------------------------------------ |
| 401  | AuthenticationRequired | Missing or invalid JWT                                 |
| 401  | Unknown group          | `repo` names no registered group (or fails to resolve) |
| 403  | Forbidden              | Caller lacks the owner role                            |
| 404  | GroupNotFound          | The group is not registered on the service             |

Because the per-group data (including the audit log) is deleted, the destroy is **not** written to the group's audit log — it is recorded only in the service's operational log.

---

## Record operations

These endpoints proxy requests to the group's backing PDS after authentication and authorization.

Each record operation accepts both the standard AT Protocol NSID and a custom alias. For example, `com.atproto.repo.createRecord` and `app.certified.group.repo.createRecord` are interchangeable. The custom NSIDs are useful when the client's PDS needs an explicit lexicon to route via `atproto-proxy`.

### `POST /xrpc/com.atproto.repo.createRecord`

Alias: `POST /xrpc/app.certified.group.repo.createRecord`

Create a new record in the group's repository.

**Required role:** member

The target group is named by the `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "collection": "app.bsky.feed.post",
  "rkey": "optional-record-key",
  "record": {
    "$type": "app.bsky.feed.post",
    "text": "Hello from the group!",
    "createdAt": "2026-01-15T12:00:00Z"
  }
}
```

**Response (200):**

```json
{
  "uri": "at://did:plc:group123/app.bsky.feed.post/3abc123",
  "cid": "bafyrei..."
}
```

**Errors:**

| Code | Name                   | Description                                            |
| ---- | ---------------------- | ------------------------------------------------------ |
| 401  | AuthenticationRequired | Missing or invalid JWT                                 |
| 401  | Unknown group          | `repo` names no registered group (or fails to resolve) |
| 403  | Forbidden              | Caller lacks member role                               |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/com.atproto.repo.createRecord \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "collection": "app.bsky.feed.post",
    "record": {
      "$type": "app.bsky.feed.post",
      "text": "Hello from the group!",
      "createdAt": "2026-01-15T12:00:00Z"
    }
  }'
```

---

### `POST /xrpc/com.atproto.repo.putRecord`

Alias: `POST /xrpc/app.certified.group.repo.putRecord`

Update an existing record or create one at a specific key.

**Required role:** Depends on context:

| Scenario                                           | Operation           | Required role |
| -------------------------------------------------- | ------------------- | ------------- |
| Updating `app.bsky.actor.profile` with rkey `self` | `putRecord:profile` | admin         |
| Updating a record you authored                     | `putOwnRecord`      | member        |
| Updating another member's record                   | `putAnyRecord`      | admin         |
| Creating a new record (no existing author)         | `createRecord`      | member        |

The target group is named by the `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "collection": "app.bsky.feed.post",
  "rkey": "3abc123",
  "record": {
    "$type": "app.bsky.feed.post",
    "text": "Updated post content",
    "createdAt": "2026-01-15T12:00:00Z"
  }
}
```

**Response (200):**

```json
{
  "uri": "at://did:plc:group123/app.bsky.feed.post/3abc123",
  "cid": "bafyrei..."
}
```

**Errors:**

| Code | Name                   | Description                                            |
| ---- | ---------------------- | ------------------------------------------------------ |
| 401  | AuthenticationRequired | Missing or invalid JWT                                 |
| 401  | Unknown group          | `repo` names no registered group (or fails to resolve) |
| 403  | Forbidden              | Caller lacks required role for this operation          |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/com.atproto.repo.putRecord \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "collection": "app.bsky.actor.profile",
    "rkey": "self",
    "record": {
      "$type": "app.bsky.actor.profile",
      "displayName": "Our Group",
      "description": "A collaborative group account"
    }
  }'
```

---

### `POST /xrpc/com.atproto.repo.deleteRecord`

Alias: `POST /xrpc/app.certified.group.repo.deleteRecord`

Delete a record from the group's repository.

**Required role:**

| Scenario                         | Operation         | Required role |
| -------------------------------- | ----------------- | ------------- |
| Deleting a record you authored   | `deleteOwnRecord` | member        |
| Deleting another member's record | `deleteAnyRecord` | admin         |

The target group is named by the `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "collection": "app.bsky.feed.post",
  "rkey": "3abc123"
}
```

**Response (200):**

```json
{}
```

**Errors:**

| Code | Name                   | Description                                            |
| ---- | ---------------------- | ------------------------------------------------------ |
| 401  | AuthenticationRequired | Missing or invalid JWT                                 |
| 401  | Unknown group          | `repo` names no registered group (or fails to resolve) |
| 403  | Forbidden              | Caller lacks required role                             |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/com.atproto.repo.deleteRecord \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "collection": "app.bsky.feed.post",
    "rkey": "3abc123"
  }'
```

---

### `POST /xrpc/com.atproto.repo.uploadBlob`

Alias: `POST /xrpc/app.certified.group.repo.uploadBlob`

Upload a blob (image, file, etc.) to the group's PDS.

**Required role:** member

The request body is the raw blob bytes, so the target group is named by the `repo` querystring parameter (`?repo=<handle-or-did>`), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request:**

- Send the raw binary data as the request body
- `Content-Type` header must match the blob's MIME type
- `Content-Length` header is required

**Response (200):**

```json
{
  "blob": {
    "$type": "blob",
    "ref": { "$link": "bafyrei..." },
    "mimeType": "image/png",
    "size": 123456
  }
}
```

**Errors:**

| Code | Name                   | Description                                            |
| ---- | ---------------------- | ------------------------------------------------------ |
| 400  | BlobTooLarge           | Blob exceeds `MAX_BLOB_SIZE` (default 5 MB)            |
| 401  | AuthenticationRequired | Missing or invalid JWT                                 |
| 401  | Unknown group          | `repo` names no registered group (or fails to resolve) |
| 403  | Forbidden              | Caller lacks member role                               |

**Example:**

```bash
curl -X POST "https://group-service.example.com/xrpc/com.atproto.repo.uploadBlob?repo=did:plc:group123" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png
```

---

## Member management

### `POST /xrpc/app.certified.group.member.add`

Add a new member to the group.

**Required role:** admin

The target group is named by the optional `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "memberDid": "did:plc:newmember",
  "role": "member"
}
```

The `role` field must be `"member"` or `"admin"`. The owner role cannot be assigned via any endpoint — it is fixed at registration and is immutable.

**Response (200):**

```json
{
  "memberDid": "did:plc:newmember",
  "role": "member",
  "addedBy": "did:plc:caller",
  "addedAt": "2026-01-15T12:00:00Z"
}
```

**Errors:**

| Code | Name                   | Description                     |
| ---- | ---------------------- | ------------------------------- |
| 400  | InvalidRole            | Role is not `member` or `admin` |
| 401  | AuthenticationRequired | Missing or invalid JWT          |
| 403  | Forbidden              | Caller lacks admin role         |
| 409  | MemberAlreadyExists    | The DID is already a member     |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.member.add \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "memberDid": "did:plc:newmember",
    "role": "member"
  }'
```

---

### `POST /xrpc/app.certified.group.member.remove`

Remove a member from the group.

**Required role:** admin (or any role for self-removal)

The target group is named by the optional `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "memberDid": "did:plc:targetmember"
}
```

**Response (200):**

```json
{}
```

**Errors:**

| Code | Name                   | Description                                                                                     |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| 400  | CannotRemoveOwner      | Cannot remove a member with the owner role                                                      |
| 401  | AuthenticationRequired | Missing or invalid JWT                                                                          |
| 403  | Forbidden              | Caller lacks admin role, or target has equal/higher role than caller (and is not removing self) |
| 404  | MemberNotFound         | Target is not a group member                                                                    |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.member.remove \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "memberDid": "did:plc:targetmember"
  }'
```

---

### `GET /xrpc/app.certified.group.member.list`

List group members with pagination.

**Required role:** member

The target group is named by the `repo` querystring parameter (`?repo=<handle-or-did>`), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Query parameters:**

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `repo`    | string | —       | Target group (handle or DID); see above    |
| `limit`   | number | 50      | Results per page (1-100)                   |
| `cursor`  | string | —       | Pagination cursor from a previous response |

**Response (200):**

```json
{
  "members": [
    {
      "did": "did:plc:owner1",
      "role": "owner",
      "addedBy": "did:plc:owner1",
      "addedAt": "2026-01-01T00:00:00Z"
    },
    {
      "did": "did:plc:admin1",
      "role": "admin",
      "addedBy": "did:plc:owner1",
      "addedAt": "2026-01-02T00:00:00Z"
    }
  ],
  "cursor": "MjAyNi0wMS0wMlQwMDowMDowMFo6OmRpZDpwbGM6YWRtaW4x"
}
```

Members are ordered by `added_at ASC, member_did ASC`. The cursor is a base64-encoded string of `added_at::member_did`.

**Example:**

```bash
curl "https://group-service.example.com/xrpc/app.certified.group.member.list?repo=did:plc:group123&limit=10" \
  -H "Authorization: Bearer $JWT"
```

---

### `POST /xrpc/app.certified.group.role.set`

Change a member's role.

**Required role:** owner

The target group is named by the optional `repo` body field (a handle or DID), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Request body:**

```json
{
  "repo": "did:plc:group123",
  "memberDid": "did:plc:targetmember",
  "role": "admin"
}
```

The `role` field can be `"member"` or `"admin"`. The owner role is immutable: a member cannot be promoted to owner, and an existing owner's role cannot be changed. Ownership transfer is a separate operation (not yet implemented).

**Response (200):**

```json
{
  "memberDid": "did:plc:targetmember",
  "role": "admin"
}
```

**Errors:**

| Code | Name                   | Description                                                     |
| ---- | ---------------------- | --------------------------------------------------------------- |
| 400  | InvalidRole            | Role is not a recognized role (`member`, `admin`, or `owner`)   |
| 400  | CannotModifyOwner      | Target already holds the owner role                             |
| 400  | CannotPromoteToOwner   | Cannot promote a member to owner                                |
| 401  | AuthenticationRequired | Missing or invalid JWT                                          |
| 403  | Forbidden              | Caller lacks owner role, or attempted to promote above own role |
| 404  | MemberNotFound         | Target is not a group member                                    |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.role.set \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "did:plc:group123",
    "memberDid": "did:plc:targetmember",
    "role": "admin"
  }'
```

---

## API key management

Owner-only methods for issuing and revoking [API keys](#authenticating-with-an-api-key). All three are authenticated with a normal owner **JWT** (not a key — a key can never manage keys). They target a group the same way as other group-scoped methods (`repo` in the body for the procedures, on the querystring for the `list` query).

### `POST /xrpc/app.certified.group.keys.create`

Mint a key. Owner-only.

Request body:

```json
{
  "repo": "did:plc:group123",
  "name": "platform backend",
  "scopes": ["rpc:app.certified.group.member.list"]
}
```

**Scope kinds:**

| kind    | form                                              | grants                                                                        |
| ------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `rpc:`  | `rpc:<method>` (friendly)                         | a service read method (`member.list`, `audit.query`)                          |
| `repo:` | `repo:<collection>?action=create\|update\|delete` | a PDS-repo write (createRecord / putRecord / deleteRecord) on that collection |
| `blob:` | `blob:<accept>` (e.g. `blob:image/*`, `blob:*/*`) | `uploadBlob` of a matching content type                                       |

For `rpc:` scopes, pass the friendly `rpc:<method>` name — a key only ever calls the CGS it was minted on, so the service binds each scope to its own audience (`?aud=did:web:<host>%23certified_group_service`) before storing; you do **not** supply an `aud`, and the response echoes the stored **canonical** form. `repo:` and `blob:` scopes carry no `aud` and are stored as given. For a `repo:` write, the scope picks the collection + action; the caller's **role** still decides whose records may be touched (a member-issued key can only mutate records that member authored — `repo:` scopes have no own-vs-any axis).

Response — the plaintext `key` is returned **only here**:

```json
{
  "keyRef": "ab12cd34",
  "key": "cgsk_ab12cd34.Zlen…",
  "scopes": [
    "rpc:app.certified.group.member.list?aud=did:web:group-service.example.com%23certified_group_service"
  ],
  "createdAt": "2026-06-06T12:00:00.000Z"
}
```

Errors: `Forbidden` (not the owner), `InvalidScope` (a scope that is unparseable, names a non-RPC method, or carries an `aud` for a different service).

### `GET /xrpc/app.certified.group.keys.list`

List the group's keys. Owner-only. Never returns the secret or its hash. Params: `repo`, `limit`, `cursor`, `includeRevoked` (default `false`).

```json
{
  "keys": [
    {
      "keyRef": "ab12cd34",
      "name": "platform backend",
      "scopes": [
        "rpc:app.certified.group.member.list?aud=did:web:group-service.example.com%23certified_group_service"
      ],
      "createdBy": "did:plc:owner",
      "createdAt": "2026-06-06T12:00:00.000Z",
      "lastUsedAt": "2026-06-06T12:05:00.000Z"
    }
  ]
}
```

### `POST /xrpc/app.certified.group.keys.delete`

Revoke a key (soft-delete; rejected on next use). Owner-only. Idempotent.

Request body: `{ "repo": "did:plc:group123", "keyRef": "ab12cd34" }`. Response: `{ "keyRef": "ab12cd34", "revokedAt": "2026-06-06T13:00:00.000Z" }`. Errors: `Forbidden`, `KeyNotFound`.

---

## Cross-group queries

These endpoints operate at the service level rather than on a single group. The JWT `aud` must be the **service DID** (not a group DID), and `lxm` must match the endpoint's NSID.

**Discovering the service DID:** The service DID is published at the `/.well-known/did.json` endpoint. Resolve it once and cache it for the lifetime of your session.

**Minting a service-level JWT:** Build the JWT exactly as you would for a group-level call, but set `aud` to the service DID instead of a group DID. The `iss`, `lxm`, `jti`, and `exp` fields work the same way. Sign the token with your DID's signing key as usual.

### `GET /xrpc/app.certified.groups.membership.list`

List all groups the authenticated user belongs to on this group service.

**Authentication:** service-level (JWT `aud` = service DID)

**Required role:** none (any authenticated user can list their own memberships)

**Query parameters:**

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `limit`   | number | 50      | Results per page (1-100)                   |
| `cursor`  | string | —       | Pagination cursor from a previous response |

**Response (200):**

```json
{
  "groups": [
    {
      "groupDid": "did:plc:group123",
      "role": "admin",
      "joinedAt": "2026-01-15T12:00:00.000Z"
    },
    {
      "groupDid": "did:plc:group456",
      "role": "member",
      "joinedAt": "2026-02-01T09:30:00.000Z"
    }
  ],
  "cursor": "MjAyNi0wMi0wMVQwOTozMDowMFo6OmRpZDpwbGM6Z3JvdXA0NTY="
}
```

Groups are ordered by `joinedAt ASC, groupDid ASC`. Paginate by passing the returned `cursor` value into the next request until `cursor` is absent from the response, which indicates the final page.

> **Treat the cursor as opaque.** Its internal format may change between service versions. Do not construct, parse, or modify cursor values — always use them exactly as returned.

**Errors:**

| Code | Name                   | Description                 |
| ---- | ---------------------- | --------------------------- |
| 400  | InvalidCursor          | Malformed pagination cursor |
| 401  | AuthenticationRequired | Missing or invalid JWT      |

**Error response format:**

```json
{
  "error": "InvalidCursor",
  "message": "Invalid cursor"
}
```

```json
{
  "error": "AuthenticationRequired",
  "message": "Authentication Required"
}
```

> **Important — single-instance scope:** This endpoint only lists groups managed by **this** group service instance. If the caller is a member of groups on other group service instances, those memberships will not appear here. There is currently no cross-service federation or discovery mechanism for memberships.

**Example:**

```bash
curl "https://group-service.example.com/xrpc/app.certified.groups.membership.list?limit=10" \
  -H "Authorization: Bearer $JWT"
```

---

## Audit log

### `GET /xrpc/app.certified.group.audit.query`

Query the group's audit log.

**Required role:** admin

The target group is named by the `repo` querystring parameter (`?repo=<handle-or-did>`), with JWT `aud` = service DID. The legacy `aud` = group DID form (no `repo`) still works but is deprecated; see [Targeting a group](#targeting-a-group).

**Query parameters:**

| Parameter    | Type   | Default | Description                                          |
| ------------ | ------ | ------- | ---------------------------------------------------- |
| `repo`       | string | —       | Target group (handle or DID); see above              |
| `limit`      | number | 50      | Results per page (1-100)                             |
| `cursor`     | string | —       | Pagination cursor from a previous response           |
| `actorDid`   | string | —       | Filter by actor DID                                  |
| `action`     | string | —       | Filter by action (e.g. `createRecord`, `member.add`) |
| `collection` | string | —       | Filter by collection NSID                            |

**Response (200):**

```json
{
  "entries": [
    {
      "id": 42,
      "actorDid": "did:plc:member1",
      "action": "createRecord",
      "collection": "app.bsky.feed.post",
      "rkey": "3abc123",
      "result": "permitted",
      "detail": {
        "collection": "app.bsky.feed.post",
        "rkey": "3abc123"
      },
      "createdAt": "2026-01-15T12:00:00Z"
    }
  ],
  "cursor": "NDI="
}
```

Entries are ordered newest first (`id DESC`). The `detail` field is a JSON object parsed from the stored JSON string.

#### Action values

Every audited operation produces one of the following `action` strings. Denied operations use the same action value with `"result": "denied"` and an additional `reason` field in `detail`.

| Action              | Trigger                                                           | `detail` fields                        |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `group.register`    | Group created via `app.certified.group.register`                  | `{ handle }`                           |
| `group.import`      | Existing account imported via `app.certified.group.import`        | `{ handle }`                           |
| `member.add`        | Member added via `member.add`                                     | `{ memberDid, role }`                  |
| `member.remove`     | Member removed via `member.remove`                                | `{ memberDid }`                        |
| `role.set`          | Role changed via `role.set`                                       | `{ memberDid, previousRole, newRole }` |
| `createRecord`      | Record created (via `createRecord` or `putRecord` for a new rkey) | `{ collection, rkey }`                 |
| `putOwnRecord`      | Caller updated a record they authored                             | `{ collection, rkey }`                 |
| `putAnyRecord`      | Caller updated another member's record                            | `{ collection, rkey }`                 |
| `putRecord:profile` | Group profile updated (`app.bsky.actor.profile` rkey `self`)      | `{ collection, rkey }`                 |
| `deleteOwnRecord`   | Caller deleted a record they authored                             | `{ collection, rkey }`                 |
| `deleteAnyRecord`   | Caller deleted another member's record                            | `{ collection, rkey }`                 |
| `uploadBlob`        | Blob uploaded via `uploadBlob`                                    | _(none)_                               |

**Denied entries** include the same `detail` fields as permitted entries, plus a `reason` string explaining why the operation was denied:

```json
{
  "action": "deleteAnyRecord",
  "result": "denied",
  "detail": {
    "collection": "app.bsky.feed.post",
    "rkey": "3abc123",
    "reason": "Forbidden: role 'member' cannot perform 'deleteAnyRecord'"
  }
}
```

**Example:**

```bash
# All audit entries
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query?repo=did:plc:group123" \
  -H "Authorization: Bearer $JWT"

# Filter by actor
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query?repo=did:plc:group123&actorDid=did:plc:member1" \
  -H "Authorization: Bearer $JWT"

# Filter by action
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query?repo=did:plc:group123&action=member.add" \
  -H "Authorization: Bearer $JWT"
```
