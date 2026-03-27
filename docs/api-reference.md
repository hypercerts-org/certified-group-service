# API Reference

All endpoints (except `/health`) require authentication via a signed JWT in the `Authorization: Bearer <token>` header. The JWT must include:

- `iss` — the caller's DID
- `aud` — the target group's DID (or the service DID for cross-group queries)
- `lxm` — the XRPC method being called
- `jti` — a unique nonce (each token can only be used once)
- `exp` — expiration timestamp

Most endpoints target a specific group (`aud` = group DID). Cross-group endpoints under `app.certified.groups.*` target the service itself (`aud` = service DID).

## Health check

### `GET /health`

Returns service health status. No authentication required.

**Response:**

```
200 OK
```

```json
{ "status": "ok" }
```

---

## Record operations

These endpoints proxy requests to the group's backing PDS after authentication and authorization.

Each record operation accepts both the standard AT Protocol NSID and a custom alias. For example, `com.atproto.repo.createRecord` and `app.certified.group.repo.createRecord` are interchangeable. The custom NSIDs are useful when the client's PDS needs an explicit lexicon to route via `atproto-proxy`.

### `POST /xrpc/com.atproto.repo.createRecord`

Alias: `POST /xrpc/app.certified.group.repo.createRecord`

Create a new record in the group's repository.

**Required role:** member

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

| Code | Name | Description |
|------|------|-------------|
| 400 | InvalidRequest | `repo` does not match the group DID |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks member role |

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

| Scenario | Operation | Required role |
|----------|-----------|---------------|
| Updating `app.bsky.actor.profile` with rkey `self` | `putRecord:profile` | admin |
| Updating a record you authored | `putOwnRecord` | member |
| Updating another member's record | `putAnyRecord` | member |
| Creating a new record (no existing author) | `createRecord` | member |

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

| Code | Name | Description |
|------|------|-------------|
| 400 | InvalidRequest | `repo` does not match the group DID |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks required role for this operation |

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

| Scenario | Operation | Required role |
|----------|-----------|---------------|
| Deleting a record you authored | `deleteOwnRecord` | member |
| Deleting another member's record | `deleteAnyRecord` | admin |

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

| Code | Name | Description |
|------|------|-------------|
| 400 | InvalidRequest | `repo` does not match the group DID |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks required role |

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

| Code | Name | Description |
|------|------|-------------|
| 400 | BlobTooLarge | Blob exceeds `MAX_BLOB_SIZE` (default 5 MB) |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks member role |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/com.atproto.repo.uploadBlob \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png
```

---

## Member management

### `POST /xrpc/app.certified.group.member.add`

Add a new member to the group.

**Required role:** admin

**Request body:**

```json
{
  "memberDid": "did:plc:newmember",
  "role": "member"
}
```

The `role` field must be `"member"` or `"admin"`. Owners cannot be added via this endpoint — use `role.set` to promote an existing member to owner.

**Response (200):**

```json
{
  "memberDid": "did:plc:newmember",
  "role": "member",
  "addedAt": "2026-01-15T12:00:00Z"
}
```

**Errors:**

| Code | Name | Description |
|------|------|-------------|
| 400 | InvalidRole | Role is not `member` or `admin` |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks admin role |
| 409 | MemberAlreadyExists | The DID is already a member |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.member.add \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "memberDid": "did:plc:newmember",
    "role": "member"
  }'
```

---

### `POST /xrpc/app.certified.group.member.remove`

Remove a member from the group.

**Required role:** admin (or any role for self-removal)

**Request body:**

```json
{
  "memberDid": "did:plc:targetmember"
}
```

**Response (200):**

```json
{}
```

**Errors:**

| Code | Name | Description |
|------|------|-------------|
| 400 | CannotRemoveOwner | Cannot remove a member with the owner role |
| 400 | CannotRemoveHigherRole | Target has equal or higher role than caller |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks admin role (and is not removing self) |
| 404 | MemberNotFound | Target is not a group member |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.member.remove \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "memberDid": "did:plc:targetmember"
  }'
```

---

### `GET /xrpc/app.certified.group.member.list`

List group members with pagination.

**Required role:** member

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Results per page (1-100) |
| `cursor` | string | — | Pagination cursor from a previous response |

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
curl "https://group-service.example.com/xrpc/app.certified.group.member.list?limit=10" \
  -H "Authorization: Bearer $JWT"
```

---

### `POST /xrpc/app.certified.group.role.set`

Change a member's role.

**Required role:** owner

**Request body:**

```json
{
  "memberDid": "did:plc:targetmember",
  "role": "admin"
}
```

The `role` field can be `"member"`, `"admin"`, or `"owner"`.

**Response (200):**

```json
{
  "memberDid": "did:plc:targetmember",
  "role": "admin"
}
```

**Errors:**

| Code | Name | Description |
|------|------|-------------|
| 400 | LastOwner | Cannot demote the last owner |
| 401 | AuthenticationRequired | Missing or invalid JWT |
| 403 | Forbidden | Caller lacks owner role |
| 404 | MemberNotFound | Target is not a group member |

**Example:**

```bash
curl -X POST https://group-service.example.com/xrpc/app.certified.group.role.set \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "memberDid": "did:plc:targetmember",
    "role": "admin"
  }'
```

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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Results per page (1-100) |
| `cursor` | string | — | Pagination cursor from a previous response |

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

| Code | Name | Description |
|------|------|-------------|
| 400 | InvalidCursor | Malformed pagination cursor |
| 401 | AuthenticationRequired | Missing or invalid JWT |

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

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Results per page (1-100) |
| `cursor` | string | — | Pagination cursor from a previous response |
| `actorDid` | string | — | Filter by actor DID |
| `action` | string | — | Filter by action (e.g. `createRecord`, `member.add`) |
| `collection` | string | — | Filter by collection NSID |

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

| Action | Trigger | `detail` fields |
|--------|---------|------------------|
| `group.register` | Group created via `app.certified.group.register` | `{ handle }` |
| `member.add` | Member added via `member.add` | `{ memberDid, role }` |
| `member.remove` | Member removed via `member.remove` | `{ memberDid }` |
| `role.set` | Role changed via `role.set` | `{ memberDid, previousRole, newRole }` |
| `createRecord` | Record created (via `createRecord` or `putRecord` for a new rkey) | `{ collection, rkey }` |
| `putOwnRecord` | Caller updated a record they authored | `{ collection, rkey }` |
| `putAnyRecord` | Caller updated another member's record | `{ collection, rkey }` |
| `putRecord:profile` | Group profile updated (`app.bsky.actor.profile` rkey `self`) | `{ collection, rkey }` |
| `deleteOwnRecord` | Caller deleted a record they authored | `{ collection, rkey }` |
| `deleteAnyRecord` | Caller deleted another member's record | `{ collection, rkey }` |
| `uploadBlob` | Blob uploaded via `uploadBlob` | *(none)* |

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
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query" \
  -H "Authorization: Bearer $JWT"

# Filter by actor
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query?actorDid=did:plc:member1" \
  -H "Authorization: Bearer $JWT"

# Filter by action
curl "https://group-service.example.com/xrpc/app.certified.group.audit.query?action=member.add" \
  -H "Authorization: Bearer $JWT"
```
