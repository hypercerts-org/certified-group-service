# Architecture

## System overview

The Certified Group Service (CGS) solves a specific problem in the AT Protocol ecosystem: **how can multiple users collaboratively manage a single atproto repository with access control?**

In standard atproto, each repository is controlled by a single identity (DID). CGS sits between clients and the group's PDS, acting as a governance layer that enforces who can do what. It manages its own membership database, tracks record authorship, and proxies all repository operations to the backing PDS using stored credentials.

```
Any atproto client
    │
    │  atproto-proxy: did:plc:GROUP#certified_group
    ▼
User's PDS
    │
    │  Authorization: Bearer <service-auth-jwt>
    │  (JWT signed with user's key, iss=user, aud=group)
    ▼
┌──────────────────────────────────┐
│  Certified Group Service         │
│                                  │
│  1. AuthVerifier  (JWT → DID)    │
│  2. RbacChecker   (DID → role)   │
│  3. PdsAgentPool  (proxy to PDS) │
│  4. AuditLogger   (record all)   │
└──────────────────────────────────┘
    │
    ▼
  Group's PDS
```

## Authentication flow

Every request must include an `Authorization: Bearer <JWT>` header. The verification process:

1. **Extract token** from the `Authorization` header
2. **Parse the XRPC method** (NSID) from the request path
3. **Validate the NSID** against the accepted whitelist:
   - `com.atproto.repo.createRecord`
   - `com.atproto.repo.putRecord`
   - `com.atproto.repo.deleteRecord`
   - `com.atproto.repo.uploadBlob`
   - `app.certified.group.member.add`
   - `app.certified.group.member.remove`
   - `app.certified.group.member.list`
   - `app.certified.group.role.set`
   - `app.certified.group.audit.query`
4. **Verify JWT signature** against the issuer's DID document using `@atproto/xrpc-server`'s `verifyJwt()`. This checks:
   - Cryptographic signature validity (resolved via the DID doc's signing key)
   - Token expiration (`exp`)
   - Lexicon method (`lxm`) matches the requested NSID
5. **Validate audience** — the JWT's `aud` claim must match a group DID registered in the `groups` table
6. **Check nonce** — the JWT's `jti` (JWT ID) is checked against the `nonce_cache` table. If it already exists, the request is rejected as a replay. Otherwise the jti is stored with a 2-minute TTL.
7. **Return** `{ iss: callerDid, aud: groupDid }` to the endpoint handler

## Service proxying

Clients don't call the group service directly. Instead, they send XRPC requests to their own PDS with an `atproto-proxy` header specifying the group DID and service fragment:

```
atproto-proxy: did:plc:GROUP#certified_group
```

The user's PDS then:

1. **Receives** the XRPC request with the `atproto-proxy` header
2. **Resolves** the group's DID document via the AT Protocol DID resolution mechanism
3. **Finds** the `#certified_group` service endpoint in the DID document
4. **Creates** a service auth JWT signed with the user's signing key (`iss=user DID`, `aud=group DID`, `lxm=NSID`)
5. **Forwards** the request to the group service endpoint with the JWT as a Bearer token
6. **Returns** the group service's response to the client

This is the same mechanism used by Ozone labeling services in the AT Protocol ecosystem.

### DID document service entry

During group registration, a service entry is added to the group's DID document via a PLC operation:

- **id**: `#certified_group`
- **type**: `CertifiedGroupService`
- **endpoint**: the service's public URL (`SERVICE_URL`)

This entry is registered automatically during `group.register` and is what allows the user's PDS to discover and forward requests to the group service.

### Nonce cache

The `NonceCache` class manages replay prevention:

- Nonces are stored in the global SQLite database's `nonce_cache` table
- Each nonce has a 120-second TTL
- A cleanup timer runs every 60 seconds to purge expired entries
- The cleanup interval is configurable and properly stopped during graceful shutdown

## Authorization (RBAC)

### Role hierarchy

```
member (0) < admin (1) < owner (2)
```

Roles are compared numerically. A higher level grants all permissions of lower levels.

### Permission matrix

| Operation | Minimum role | Description |
|-----------|-------------|-------------|
| `createRecord` | member | Create new records in the group repo |
| `uploadBlob` | member | Upload media/blobs |
| `deleteOwnRecord` | member | Delete records you authored |
| `putOwnRecord` | member | Edit records you authored |
| `putAnyRecord` | member | Edit any member's records |
| `member.list` | member | List group members |
| `deleteAnyRecord` | admin | Delete any member's records |
| `putRecord:profile` | admin | Edit the group's profile (`app.bsky.actor.profile` / `self`) |
| `member.add` | admin | Add new members |
| `member.remove` | admin | Remove members (with restrictions) |
| `audit.query` | admin | Query the audit log |
| `role.set` | owner | Change member roles |

### Special rules

- **Cannot modify equal or higher roles**: An admin cannot remove another admin; only owners can
- **Cannot assign roles above assignable set**: `member.add` only allows assigning `member` or `admin` — not `owner`
- **Self-removal always succeeds**: Any member can remove themselves regardless of role
- **Last-owner protection**: The system prevents demoting or removing the last owner via an atomic transaction check
- **Author-based record ownership**: `putRecord` and `deleteRecord` check the `group_record_authors` table to determine if the caller authored the record, then select the appropriate operation (`putOwnRecord` / `putAnyRecord` vs `putRecord:profile`, `deleteOwnRecord` vs `deleteAnyRecord`). Any member can edit any record; authorship only restricts deletion (`deleteAnyRecord` requires admin).

### RBAC enforcement

The `RbacChecker` class provides two key methods:

- `assertCan(groupDb, memberDid, operation)` — looks up the member's role, compares against the operation's minimum role, and throws `UnauthorizedError` (not a member) or `ForbiddenError` (insufficient role) on failure. Returns the member's role on success.
- `isAuthor(groupDb, recordUri, memberDid)` — checks if a specific member authored a record.

## Data model

### Global database (`global.sqlite`)

#### `groups`

| Column | Type | Description |
|--------|------|-------------|
| `did` | TEXT (PK) | The group's DID |
| `pds_url` | TEXT | URL of the group's backing PDS |
| `encrypted_app_password` | TEXT | AES-256-GCM encrypted app password for PDS login |
| `created_at` | TEXT | ISO timestamp, defaults to current time |

#### `nonce_cache`

| Column | Type | Description |
|--------|------|-------------|
| `jti` | TEXT (PK) | JWT ID (nonce) |
| `expires_at` | TEXT | Expiration timestamp |

Indexed on `expires_at` for efficient cleanup.

### Per-group databases (`data/groups/{hash}.sqlite`)

Each group gets its own SQLite database, named by the SHA-256 hash of the group DID. This provides isolation between groups.

#### `group_members`

| Column | Type | Description |
|--------|------|-------------|
| `member_did` | TEXT (PK) | Member's DID |
| `role` | TEXT | `member`, `admin`, or `owner` |
| `added_by` | TEXT | DID of the member who added this person |
| `added_at` | TEXT | ISO timestamp |

Composite index on `(added_at, member_did)` for efficient paginated listing.

#### `group_record_authors`

| Column | Type | Description |
|--------|------|-------------|
| `record_uri` | TEXT (PK) | AT URI of the record |
| `author_did` | TEXT | DID of the member who created it |
| `collection` | TEXT | Collection NSID |
| `created_at` | TEXT | ISO timestamp |

Indexed on `author_did` for authorship lookups.

#### `group_audit_log`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, auto) | Sequential entry ID |
| `actor_did` | TEXT | DID of the person who performed the action |
| `action` | TEXT | Operation name (e.g. `createRecord`, `member.add`) |
| `collection` | TEXT | Collection NSID (for record operations) |
| `rkey` | TEXT | Record key (for record operations) |
| `result` | TEXT | `permitted` or `denied` |
| `detail` | TEXT | JSON-encoded additional context |
| `jti` | TEXT | JWT ID for request tracing |
| `created_at` | TEXT | ISO timestamp |

Indexed on `created_at`, `actor_did`, `action`, and `collection` for efficient querying.

## PDS proxy layer

### Agent pool

The `PdsAgentPool` manages authenticated connections to each group's PDS:

1. **Lookup**: When a request targets a group, the pool checks its cache for an existing agent
2. **Credential decryption**: If no cached agent exists, the group's `encrypted_app_password` is decrypted from the database using the master encryption key
3. **Login**: An `AtpAgent` is created and logs in with the group's DID and decrypted app password
4. **Caching**: The authenticated agent is cached for subsequent requests
5. **Auto-retry**: The `withAgent()` method wraps operations and automatically retries on `AuthenticationRequired` or `ExpiredToken` errors by invalidating the cache and re-authenticating

### Credential encryption

App passwords are encrypted at rest using **AES-256-GCM**:

- **Key**: 32-byte master key from the `ENCRYPTION_KEY` environment variable
- **IV**: 12 random bytes generated per encryption
- **Auth tag**: 16 bytes for integrity verification
- **Storage format**: Base64 encoding of `IV || AuthTag || Ciphertext`

### Blob streaming

The `uploadBlob` endpoint streams blob data to the PDS with size enforcement:

- The `Content-Length` header is checked upfront for fast rejection
- The request body is buffered with per-chunk size tracking
- If the accumulated size exceeds `MAX_BLOB_SIZE`, the request is immediately rejected with `BlobTooLarge`

## Audit logging

The `AuditLogger` records every meaningful action in the per-group `group_audit_log` table.

### What gets logged

- All record operations (create, put, delete) — both permitted and denied
- Blob uploads
- Member management (add, remove)
- Role changes
- RBAC denials (with the reason for denial)

### Entry structure

Each log entry captures:

- **Who**: `actor_did` — the DID of the person performing the action
- **What**: `action` — the operation name
- **Where**: `collection` and `rkey` — for record-level operations
- **Result**: `permitted` or `denied`
- **Detail**: JSON object with additional context (e.g. `{ memberDid, role }` for member operations, `{ reason }` for denials)
- **Tracing**: `jti` — the JWT ID for correlating with auth logs
- **When**: `created_at` — ISO timestamp

## Group lifecycle

1. **Registration**: `group.register` requires a service auth JWT proving the caller controls the `ownerDid`. It then creates a PDS account, registers a `#certified_group` service endpoint in the group's DID document, stores encrypted credentials, and seeds the owner.
2. **Database creation**: On startup, CGS loads all groups from the registry and runs per-group migrations for each, creating the group's SQLite database if it doesn't exist.
3. **First owner**: The first owner is automatically seeded into the group's `group_members` table during `group.register`. After that, the owner can manage the group through the API.
4. **Ongoing management**: Owners can promote admins, admins can add/remove members, and all authorized members can interact with the group's repository.

## Startup sequence

1. Load and validate configuration via Zod
2. Create structured logger (pino)
3. Ensure `DATA_DIR` exists
4. Open global SQLite database and run global migrations
5. Initialize the per-group database pool
6. Create the DID resolver (`IdResolver` from `@atproto/identity`)
7. Load all managed groups and run per-group migrations
8. Initialize auth (AuthVerifier, NonceCache with 60s cleanup interval)
9. Initialize RBAC checker
10. Create Express app with middleware:
    - `trust proxy = 1`
    - pino-http request logging
    - JSON body parser (skipped for `uploadBlob`)
    - `/health` endpoint
    - All XRPC route handlers
    - XRPC error handler
11. Start listening on configured port
12. Register graceful shutdown handlers (SIGTERM, SIGINT):
    - Stop accepting connections
    - Destroy keep-alive sockets
    - Close server
    - Close all group databases
    - Close global database
