# Group-Governed PDS: Complete Implementation Specification

## The Constraint, Restated

The Group Service is **interoperable infrastructure**. Your web app uses it, but so can any other atproto-aware client or web app — ones you don't control. If someone builds a different client and a user logs in via their ePDS (or any PDS), that client should be able to write to the group repo through the same RBAC mechanism.

This means the Group Service must be a **standalone atproto service** — like Ozone is for moderation — reachable via the standard `atproto-proxy` mechanism from any PDS.

No PDS modifications. App passwords for group PDS credentials. Credible exit for owners.

---

## Technology Stack (Exact Versions & Packages)

### Language & Runtime

| Component | Choice | Version | Why |
|-----------|--------|---------|-----|
| Language | **TypeScript** | 5.5+ | The atproto ecosystem is TypeScript-native. Ozone, the PDS, and all `@atproto/*` packages are TS. Fighting this would be masochistic. |
| Runtime | **Node.js** | 22 LTS | Required by `@atproto/xrpc-server` (Express-based). Bun/Deno not tested against the atproto packages. |
| Package Manager | **pnpm** | 9.x | Used by the atproto monorepo itself. Workspace support if you split into packages later. |

### Core atproto Packages

```jsonc
// package.json dependencies
{
  "@atproto/xrpc-server": "^0.10.15",   // Express-based XRPC server framework, JWT verification
  "@atproto/api": "^0.19.3",            // Agent for talking to the group's PDS (app password auth)
  "@atproto/identity": "^0.4.12",       // DID resolution (did:plc, did:web), handle resolution
  "@atproto/crypto": "^0.4.5",          // P-256 / secp256k1 key ops, signature verification
  "@atproto/lexicon": "^0.6.2",         // Lexicon schema definition & validation
  "@atproto/syntax": "^0.5.0",          // AT URI, NSID, handle, DID syntax parsing
  "@atproto/common-web": "^0.4.18",     // DID document helpers (getServiceEndpoint, getSigningKey)
}
```

### Application Dependencies

```jsonc
{
  // Database
  "kysely": "^0.27.0",                  // Type-safe SQL query builder (same as PDS uses)
  "better-sqlite3": "^11.0.0",          // SQLite driver (global + per-group tables)

  // HTTP / Server
  "express": "^4.21.0",                 // Required by @atproto/xrpc-server (it wraps Express)

  // Configuration
  "dotenv": "^16.4.0",                  // Environment variable loading
  "zod": "^3.23.0",                     // Config validation (same as atproto monorepo uses)

  // Logging
  "pino": "^9.0.0",                     // Structured JSON logging (same as PDS/Ozone use)
  "pino-http": "^10.0.0",              // HTTP request logging middleware
}
```

### Dev Dependencies

```jsonc
{
  "typescript": "^5.5.0",
  "tsx": "^4.19.0",                     // TypeScript execution (dev + scripts)
  "vitest": "^2.1.0",                   // Test runner
  "@types/express": "^4.17.21",
  "@types/better-sqlite3": "^7.6.0",
  "eslint": "^9.0.0",
  "prettier": "^3.3.0",
}
```

### Build & Deploy

```jsonc
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "migrate": "tsx src/db/migrate.ts",
    "migrate:create": "tsx src/db/create-migration.ts"
  }
}
```

---

## Architecture Diagram

```
Any atproto client (your app, third-party apps, CLI tools, bots)
       │
       │ OAuth session with user's PDS (ePDS or any other)
       │ + atproto-proxy: did:plc:GROUP_DID#group_service
       │
       ▼
┌──────────────────┐
│  User's PDS      │  (ePDS, bsky.social, self-hosted, whatever)
│                  │
│  Verifies user   │
│  Signs service   │
│  auth JWT:       │
│   iss = user DID │
│   aud = group DID│
│   lxm = method   │
│   jti = nonce    │
│                  │
│  Proxies request │
│  to Group Service│
│  URL from group  │
│  DID document    │
└────────┬─────────┘
         │
         │  HTTPS + service auth JWT
         ▼
┌──────────────────────────────────────────────────┐
│              GROUP SERVICE                        │
│              (Railway Pro plan)                   │
│                                               │
│                                                   │
│  Node.js 22 + @atproto/xrpc-server               │
│                                                   │
│  1. Verify service auth JWT                       │
│     - @atproto/xrpc-server verifyJwt()            │
│     - @atproto/identity IdResolver                │
│     - check jti not replayed (global SQLite)       │
│                                                   │
│  2. Verify repo field matches aud (group DID)     │
│                                                   │
│  3. RBAC check                                    │
│     - Kysely query → per-group SQLite              │
│                                                   │
│  4. Execute write on group's PDS                  │
│     - @atproto/api Agent (app password session)   │
│     - com.atproto.repo.createRecord / uploadBlob  │
│                                                   │
│  5. Audit log (per-group SQLite) + return result  │
│                                                   │
└────────┬─────────────────────────────────────────┘
         │
         │ XRPC (app password auth)
         ▼
┌──────────────────┐
│  Group's PDS     │
│  (Railway,       │
│   ghcr.io/       │
│   bluesky-social/│
│   pds:0.4,       │
│   volume at /pds)│
│   SQLite + disk  │
│   blob storage)  │
└──────────────────┘
```

---

## Project Structure

```
group-service/
├── package.json
├── tsconfig.json
├── .env.example
├── Dockerfile
├── railway.toml                      # Railway deployment config
├── data/                                # Persistent volume
│   ├── global.sqlite                    # Groups registry, nonce cache
│   └── groups/                          # Per-group SQLite files
│       ├── did_plc_abc123.sqlite
│       └── did_plc_def456.sqlite
├── lexicons/                         # Lexicon JSON files
│   └── org/
│       └── groupds/
│           ├── member/
│           │   ├── list.json
│           │   ├── add.json
│           │   └── remove.json
│           ├── role/
│           │   └── set.json
│           └── audit/
│               └── query.json
├── src/
│   ├── index.ts                      # Entrypoint: create server, listen
│   ├── config.ts                     # Zod-validated env config
│   ├── context.ts                    # AppContext type definition (see AppContext section)
│   ├── errors.ts                    # UnauthorizedError, ForbiddenError (XRPCError subclasses)
│   ├── server.ts                     # XRPC server setup, lexicon registration
│   ├── auth/
│   │   ├── verifier.ts              # Service auth JWT verification (mirrors Ozone pattern)
│   │   └── nonce.ts                 # SQLite-backed JTI nonce cache
│   ├── audit.ts                     # AuditLogger class (wraps group_audit_log inserts)
│   └── api/
│   │   ├── index.ts                 # Route registration
│   │   ├── util.ts                  # xrpcHandler wrapper, shared across all handlers
│   │   ├── error-handler.ts         # XRPC error middleware (maps errors to JSON responses)
│   │   ├── repo/
│   │   │   ├── createRecord.ts      # com.atproto.repo.createRecord handler
│   │   │   ├── deleteRecord.ts      # com.atproto.repo.deleteRecord handler
│   │   │   ├── putRecord.ts         # com.atproto.repo.putRecord handler
│   │   │   └── uploadBlob.ts        # com.atproto.repo.uploadBlob handler (buffered blob proxy)
│   │   ├── member/
│   │   │   ├── list.ts
│   │   │   ├── add.ts
│   │   │   └── remove.ts
│   │   ├── role/
│   │   │   └── set.ts
│   │   └── audit/
│   │       └── query.ts
│   ├── rbac/
│   │   ├── permissions.ts           # Permission matrix (role → allowed operations)
│   │   └── check.ts                 # RBAC enforcement logic
│   ├── pds/
│   │   ├── agent.ts                 # @atproto/api Agent pool, one per group
│   │   └── credentials.ts           # AES-256-GCM encrypted app password storage/retrieval
│   ├── db/
│   │   ├── schema.ts                # Kysely table types (GlobalDatabase + GroupDatabase)
│   │   ├── migrate.ts               # Migration runner (global SQLite + per-group SQLite)
│   │   ├── group-db-pool.ts         # GroupDbPool: opens/caches per-group SQLite connections
│   │   └── migrations/
│   │       ├── global/
│   │       │   └── 001_initial.ts   # groups, nonce_cache (global SQLite)
│   │       └── group/
│   │           └── 001_initial.ts   # group_members, group_record_authors, group_audit_log (SQLite)
└── tests/
    ├── auth.test.ts                 # JWT verification, nonce replay rejection
    ├── rbac.test.ts                 # Permission matrix, role hierarchy, edge cases
    ├── repo.test.ts                 # createRecord, deleteRecord, putRecord handlers
    ├── membership.test.ts           # member.add, member.remove, role.set handlers
    ├── credentials.test.ts          # AES-256-GCM encrypt/decrypt round-trip
    └── helpers/
        ├── mock-server.ts           # Test helpers using vitest
        └── test-db.ts               # Test SQLite setup per test suite
```

---

## DID Document Setup

The group account's DID document needs a service entry pointing to the Group Service. This is how any PDS in the network discovers where to forward proxied requests.

When the group account is created on the group's PDS (which is `did:plc`), a PLC operation adds a service entry:

```json
{
  "type": "plc_operation",
  "rotationKeys": ["did:key:zQ3sh...ownerRotationKey"],
  "verificationMethods": {
    "atproto": "did:key:zQ3sh...signingKey"
  },
  "alsoKnownAs": ["at://mygroup.example.com"],
  "services": {
    "atproto_pds": {
      "type": "AtprotoPersonalDataServer",
      "endpoint": "https://pds.example.com"
    },
    "group_service": {
      "type": "CertifiedGroupService",
      "endpoint": "https://group-service.example.com"
    }
  },
  "prev": "<CID of previous operation>",
  "sig": "<base64url ECDSA signature>"
}
```

### How to Actually Submit This PLC Operation

This is a one-time setup step. You need:

1. **The rotation key** — the secp256k1 private key that controls the DID. The group's PDS holds one (from `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX`), and the owner should hold another (higher priority).

2. **Fetch current state**:
   ```bash
   curl https://plc.directory/did:plc:XXXXX/data
   # Returns current rotationKeys, verificationMethods, alsoKnownAs, services

   curl https://plc.directory/did:plc:XXXXX/log/audit
   # Returns array of operations — last one's CID is your "prev"
   ```

3. **Build the new operation**: Copy all existing fields, add the `group_service` service entry, set `prev` to the CID of the most recent operation.

4. **Sign it**:
   - Remove `sig` field
   - Encode as DAG-CBOR (`@ipld/dag-cbor` package)
   - Sign with rotation key using secp256k1 ECDSA-SHA256
   - Low-S normalize the signature
   - Encode as base64url (64 bytes: 32-byte r + 32-byte s)

5. **Submit**:
   ```bash
   curl -X POST https://plc.directory/did:plc:XXXXX \
     -H "Content-Type: application/json" \
     -d '{ ...signedOperation }'
   ```

We should build a CLI script (`scripts/plc-add-service.ts`) that automates this.

**Extra packages for PLC ops:**
```jsonc
{
  "@ipld/dag-cbor": "^9.2.0",    // DAG-CBOR encoding for PLC operations
  "multiformats": "^13.0.0",     // CID computation
}
```

---

## Lexicons

### Standard NSIDs for CRUD Operations

The Group Service registers handlers for standard `com.atproto.repo.*` NSIDs. When a client uses `withProxy` to route through the Group Service, the PDS proxies the standard XRPC calls. The Group Service intercepts these, performs RBAC checks, and forwards the writes to the group's PDS. No custom lexicons are needed for CRUD — clients use normal `@atproto/api` typed methods out of the box:

```
com.atproto.repo.createRecord   — Intercepted: create a record in the group repo
com.atproto.repo.deleteRecord   — Intercepted: delete a record from the group repo
com.atproto.repo.putRecord      — Intercepted: put (upsert) a record
com.atproto.repo.uploadBlob     — Intercepted: upload a blob to the group repo
```

The `lxm` claim in the service auth JWT will be the standard NSID (e.g., `com.atproto.repo.createRecord`). The Group Service's `verifyJwt` accepts these standard NSIDs.

**Important**: The Group Service verifies that the `repo` field in the request input matches `aud` (the group DID from the JWT). This prevents someone from using the proxy to write to a different repo.

### Custom Lexicons (Namespace: `app.certified.group.*`)

Custom lexicons are only needed for group management operations that have no standard atproto equivalent:

```
app.certified.group.member.list         — List members and roles (if caller is a member)
app.certified.group.member.add          — Add a member (admin+)
app.certified.group.member.remove       — Remove a member (admin+)
app.certified.group.role.set            — Change a member's role (owner only)
app.certified.group.audit.query         — Query audit log (admin+)
```

### Lexicon: `app.certified.group.member.add`

```json
{
  "lexicon": 1,
  "id": "app.certified.group.member.add",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Add a member to the group. Requires admin or owner role.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["memberDid", "role"],
          "properties": {
            "memberDid": { "type": "string", "format": "did" },
            "role": {
              "type": "string",
              "knownValues": ["member", "admin"]
            }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["memberDid", "role", "addedAt"],
          "properties": {
            "memberDid": { "type": "string", "format": "did" },
            "role": { "type": "string" },
            "addedAt": { "type": "string", "format": "datetime" }
          }
        }
      },
      "errors": [
        { "name": "Unauthorized" },
        { "name": "Forbidden" },
        { "name": "MemberAlreadyExists" }
      ]
    }
  }
}
```

### Lexicon: `app.certified.group.member.list`

```json
{
  "lexicon": 1,
  "id": "app.certified.group.member.list",
  "defs": {
    "main": {
      "type": "query",
      "description": "List members of the group. Requires membership.",
      "parameters": {
        "type": "params",
        "properties": {
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
          "cursor": { "type": "string" }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["members"],
          "properties": {
            "cursor": { "type": "string" },
            "members": {
              "type": "array",
              "items": { "type": "ref", "ref": "#member" }
            }
          }
        }
      },
      "errors": [
        { "name": "Unauthorized" }
      ]
    },
    "member": {
      "type": "object",
      "required": ["did", "role", "addedAt"],
      "properties": {
        "did": { "type": "string", "format": "did" },
        "role": { "type": "string" },
        "addedBy": { "type": "string", "format": "did" },
        "addedAt": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

### Lexicon: `app.certified.group.member.remove`

```json
{
  "lexicon": 1,
  "id": "app.certified.group.member.remove",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Remove a member from the group. Requires admin or owner role.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["memberDid"],
          "properties": {
            "memberDid": { "type": "string", "format": "did" }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {}
        }
      },
      "errors": [
        { "name": "Unauthorized" },
        { "name": "Forbidden" },
        { "name": "MemberNotFound" },
        { "name": "CannotRemoveOwner" }
      ]
    }
  }
}
```

### Lexicon: `app.certified.group.role.set`

```json
{
  "lexicon": 1,
  "id": "app.certified.group.role.set",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Change a member's role. Owner only.",
      "input": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["memberDid", "role"],
          "properties": {
            "memberDid": { "type": "string", "format": "did" },
            "role": {
              "type": "string",
              "knownValues": ["member", "admin", "owner"]
            }
          }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["memberDid", "role"],
          "properties": {
            "memberDid": { "type": "string", "format": "did" },
            "role": { "type": "string" }
          }
        }
      },
      "errors": [
        { "name": "Unauthorized" },
        { "name": "Forbidden" },
        { "name": "MemberNotFound" },
        { "name": "LastOwnerDemotion", "description": "Cannot demote the last owner — promote a replacement first" }
      ]
    }
  }
}
```

### Lexicon: `app.certified.group.audit.query`

```json
{
  "lexicon": 1,
  "id": "app.certified.group.audit.query",
  "defs": {
    "main": {
      "type": "query",
      "description": "Query the audit log. Requires admin or owner role.",
      "parameters": {
        "type": "params",
        "properties": {
          "actorDid": { "type": "string", "format": "did" },
          "action": { "type": "string" },
          "collection": { "type": "string" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
          "cursor": { "type": "string" }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["entries"],
          "properties": {
            "cursor": { "type": "string" },
            "entries": {
              "type": "array",
              "items": { "type": "ref", "ref": "#auditEntry" }
            }
          }
        }
      },
      "errors": [
        { "name": "Unauthorized" },
        { "name": "Forbidden" }
      ]
    },
    "auditEntry": {
      "type": "object",
      "required": ["id", "actorDid", "action", "result", "createdAt"],
      "properties": {
        "id": { "type": "string" },
        "actorDid": { "type": "string", "format": "did" },
        "action": { "type": "string" },
        "collection": { "type": "string" },
        "rkey": { "type": "string" },
        "result": { "type": "string", "knownValues": ["permitted", "denied"] },
        "detail": { "type": "unknown" },
        "createdAt": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

---

## How Blobs Work Through the Proxy Chain

```
Client  ──blob bytes──►  User's PDS  ──blob bytes──►  Group Service  ──blob bytes──►  Group's PDS
                          (proxies)                    (RBAC check)                    (stores)
```

The user's PDS forwards the raw request body (the blob bytes) to the Group Service via `atproto-proxy`. The PDS doesn't interpret the body — it proxies it along with the service auth JWT in the `Authorization` header and the original `Content-Type`, `Content-Encoding`, and `Content-Length` headers.

The Group Service receives the blob bytes, verifies the JWT, checks RBAC, then forwards those bytes to the group's PDS using the group account's app password session via `com.atproto.repo.uploadBlob`.

This is the standard `com.atproto.repo.uploadBlob` NSID — no custom lexicon needed. The Group Service registers a handler for this standard NSID.

**Known inefficiency**: This is a triple-hop (client -> user's PDS -> Group Service -> group's PDS) where the blob bytes traverse three network hops. For MVP this is the only option without PDS modifications. A future optimization could allow the client to upload to its own PDS first, then have the Group Service fetch the blob via `com.atproto.sync.getBlob` (which is public/unauthenticated) and re-upload it to the group's PDS — reducing the data transferred through the proxy to just a blob reference.

### Blob Upload Implementation (Buffered)

```typescript
// src/api/repo/uploadBlob.ts
import { XRPCError } from '@atproto/xrpc-server'
import type { Server } from '../server'
import type { AppContext } from '../context'

export default function (server: Server, ctx: AppContext) {
  server.app.post('/xrpc/com.atproto.repo.uploadBlob', async (req, res) => {
    // 1. Authenticate & authorize
    const { iss: callerDid, aud: groupDid } = await ctx.authVerifier.verify(req)
    await ctx.rbac.assertCan(callerDid, groupDid, 'uploadBlob')

    // 2. Buffer the blob and forward to group's PDS via withAgent (handles session refresh)
    // Note: @atproto/api uploadBlob accepts Uint8Array, not streams.
    // For large blobs, consider using undici to POST directly to the group's PDS XRPC endpoint.
    // Check Content-Length upfront (fast reject), then enforce mid-stream (defense against lies)
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
    if (contentLength > ctx.config.maxBlobSize) {
      throw new XRPCError(400, 'BlobTooLarge', 'Blob exceeds size limit')
    }

    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      totalSize += chunk.length
      if (totalSize > ctx.config.maxBlobSize) {
        throw new XRPCError(400, 'BlobTooLarge', 'Blob exceeds size limit')
      }
    }
    const blobData = Buffer.concat(chunks)
    const contentType = req.headers['content-type'] ?? 'application/octet-stream'
    const response = await ctx.pdsAgents.withAgent(groupDid, (agent) =>
      agent.com.atproto.repo.uploadBlob(blobData, { encoding: contentType }),
    )

    // 4. Audit log
    const groupDb = ctx.groupDbs.get(groupDid)
    await ctx.audit.log(groupDb, callerDid, 'uploadBlob', 'permitted')

    // 5. Return blob ref
    res.json(response.data)
  })
}
```

### Size Limits

| Layer | Limit | Source |
|-------|-------|--------|
| User's PDS | Configured per-PDS (default ~100MB) | `PDS_BLOB_UPLOAD_LIMIT` |
| Group Service | **10MB default** (configurable per-group) | Our config |
| Group's PDS | Configured on the group's PDS (default ~100MB) | `PDS_BLOB_UPLOAD_LIMIT` |

The Group Service should enforce its own limit as the first line of defense. Check `Content-Length` header before streaming and abort if exceeded. Also track bytes streamed and abort mid-stream if the client lies about `Content-Length`.

---

## Client Integration

### From Your Web App

```typescript
import { Agent } from '@atproto/api'

// User is logged in via ePDS OAuth
const userAgent = new Agent(oauthSession)

// Create a proxied client pointing at the group service
const groupClient = userAgent.withProxy('group_service', GROUP_DID)

// This goes: client → user's ePDS → Group Service → group's PDS
// Standard typed SDK methods work out of the box via withProxy
await groupClient.com.atproto.repo.createRecord({
  repo: GROUP_DID,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'Posted by a group member',
    createdAt: new Date().toISOString(),
  },
})
```

### From Any Third-Party App

A completely different app can do the same thing. They just need to:

1. Know the group account's DID (public information)
2. Authenticate their user via any PDS
3. Set `atproto-proxy: did:plc:GROUP_DID#group_service`
4. Call standard `com.atproto.repo.*` methods for CRUD, or `app.certified.group.*` for group management

### Blob Upload From a Client

```typescript
// 1. Upload blob through the proxy chain
const blobResponse = await groupClient.com.atproto.repo.uploadBlob(
  imageBytes,
  { encoding: 'image/jpeg' },
)

// 2. Use the blob ref in a record
await groupClient.com.atproto.repo.createRecord({
  repo: GROUP_DID,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'Photo from the group',
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{
        alt: 'Group photo',
        image: blobResponse.data.blob,
      }],
    },
    createdAt: new Date().toISOString(),
  },
})
```

---

## Service Auth JWT Verification (Core Security Boundary)

### What the User's PDS Sends

**Note on OAuth vs service auth:** The user authenticates to their PDS via OAuth (or app password). When the PDS proxies to another service, it signs a *new* JWT with the user's signing key — that's the service auth JWT. The OAuth token never leaves the PDS<->client relationship. The downstream service only ever sees the service auth JWT. This is specified in the atproto service auth spec and is how Ozone works today.

When a client sets `atproto-proxy: did:plc:GROUP_DID#group_service`, the user's PDS:

1. Authenticates the user (via their OAuth session or app password)
2. Signs a service auth JWT with the user's atproto signing key
3. Forwards the request to the Group Service URL (from the group DID doc)

The JWT contains:
- `iss`: the user's DID
- `aud`: the group's DID
- `lxm`: the NSID of the endpoint (e.g., `com.atproto.repo.createRecord`)
- `exp`: expiration (60 seconds from now)
- `jti`: random 128-bit hex nonce

### Verification Implementation (Mirrors Ozone Pattern)

```typescript
// src/auth/verifier.ts
import { IdResolver } from '@atproto/identity'
import { verifyJwt, parseReqNsid } from '@atproto/xrpc-server'
import type { Request } from 'express'
import { NonceCache } from './nonce'

// The accepted lxm values: standard CRUD NSIDs + custom group management NSIDs
const ACCEPTED_NSIDS = new Set([
  'com.atproto.repo.createRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.uploadBlob',
  'app.certified.group.member.list',
  'app.certified.group.member.add',
  'app.certified.group.member.remove',
  'app.certified.group.role.set',
  'app.certified.group.audit.query',
])

export class AuthVerifier {
  constructor(
    private idResolver: IdResolver,
    private nonceCache: NonceCache,
    private groupDids: Set<string>, // all group DIDs this instance manages
  ) {}

  async verify(req: Request): Promise<{ iss: string; aud: string }> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthRequiredError('Missing auth token')
    }
    const jwtStr = authHeader.slice(7)
    const nsid = parseReqNsid(req)

    if (!ACCEPTED_NSIDS.has(nsid)) {
      throw new AuthRequiredError(`Unsupported NSID: ${nsid}`)
    }

    // verifyJwt checks: aud, lxm, exp, signature against DID doc.
    // We pass null for aud and check it ourselves because verifyJwt expects a single
    // aud string, but we support multiple groups. The aud in the JWT *is* clearly
    // scoped to the group's DID — we just do the check manually below.
    const payload = await verifyJwt(
      jwtStr,
      null,  // we check aud ourselves below
      nsid,  // lxm must match the called endpoint
      async (did: string, forceRefresh: boolean): Promise<string> => {
        const atprotoData = await this.idResolver.did.resolveAtprotoData(
          did,
          forceRefresh,
        )
        return atprotoData.signingKey
      },
    )

    // Check aud is one of our managed group DIDs
    if (!payload.aud || !this.groupDids.has(payload.aud)) {
      throw new AuthRequiredError('Invalid audience')
    }

    // Check jti not replayed
    // jti is required per atproto service auth spec — reject tokens without it
    if (!payload.jti) {
      throw new AuthRequiredError('Missing jti in service auth token')
    }
    const isNew = await this.nonceCache.checkAndStore(payload.jti)
    if (!isNew) {
      throw new AuthRequiredError('Replayed token')
    }

    return { iss: payload.iss, aud: payload.aud }
  }
}
```

### Repo Field Validation

For `com.atproto.repo.createRecord`, `deleteRecord`, and `putRecord`, the Group Service must verify that the `repo` field in the request body matches the `aud` (group DID) from the JWT. This prevents a caller from using the proxy to write to a different repo:

```typescript
// In each repo handler, after auth verification:
const input = req.body
if (input.repo !== groupDid) {
  throw new ForbiddenError('repo field must match the group DID')
}
```

### Nonce Cache (Global SQLite)

```typescript
// src/auth/nonce.ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { GlobalDatabase } from '../db/schema'

const NONCE_TTL_SECONDS = 120 // slightly longer than JWT expiry (60s)

export class NonceCache {
  constructor(private db: Kysely<GlobalDatabase>) {}

  async checkAndStore(jti: string): Promise<boolean> {
    // INSERT ... ON CONFLICT DO NOTHING — atomic upsert
    // SQLite: RETURNING is supported since 3.35.0 (Node 22 ships 3.45+)
    const result = await this.db
      .insertInto('nonce_cache')
      .values({
        jti,
        expires_at: sql`datetime('now', '+${sql.raw(String(NONCE_TTL_SECONDS))} seconds')`,
      })
      .onConflict((oc) => oc.column('jti').doNothing())
      .returning('jti')
      .executeTakeFirst()

    return result !== undefined // true = new nonce, false = replay
  }

  /**
   * Call periodically (e.g., every 60s via setInterval).
   * Under sustained attack, the nonce_cache table can grow large between cleanups.
   * The per-DID rate limiter (see rate limiting section) mitigates this by bounding
   * the ingestion rate. If needed, reduce cleanup interval or add DELETE ... LIMIT.
   */
  async cleanup(): Promise<void> {
    await this.db
      .deleteFrom('nonce_cache')
      .where('expires_at', '<', sql`datetime('now')`)
      .execute()
  }
}
```

### Security Properties

- A user's PDS can act on behalf of that user (by design — same trust model as browser)
- No other entity can forge requests as that user
- The Group Service independently verifies identity via DID resolution through `plc.directory`
- RBAC further restricts what each verified identity can do
- JTI nonce prevents replay attacks within the 120s window
- `lxm` claim in the JWT is verified against the actual endpoint NSID, preventing a JWT issued for one method from being used on another
- The `repo` field in CRUD requests is validated against the `aud` (group DID) to prevent cross-repo writes
- The Group Service sits behind Railway's TLS termination; `trust proxy` is set so `req.ip` reflects the real client. All group PDS communication uses HTTPS (public URL)
- Collection writes are currently unrestricted — any member can write to any NSID (e.g., `app.bsky.graph.block`). **Post-MVP**: add per-group collection allowlists (see open question). For MVP, document that group owners should only invite trusted members

---

## RBAC: Private Membership

### Database Schema

The database is split into two layers:

- **Global SQLite** (via `better-sqlite3`): `groups` registry, `nonce_cache` for JWT replay prevention — stored at `data/global.sqlite`
- **Per-group SQLite** (via `better-sqlite3`): `group_members`, `group_record_authors`, `group_audit_log`

Each group gets its own SQLite file at `data/groups/{sanitized_did}.sqlite`. This provides physical data isolation, trivial per-group export (copy one file), and clean deletion (delete one file). The global database is a single file that indexes all managed groups and their PDS credentials.

#### Global Migration (SQLite)

```typescript
// src/db/migrations/global/001_initial.ts
import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Groups table — one row per managed group
  await db.schema
    .createTable('groups')
    .addColumn('did', 'text', (col) => col.primaryKey())
    .addColumn('pds_url', 'text', (col) => col.notNull())
    .addColumn('encrypted_app_password', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) =>
      col.defaultTo(sql`datetime('now')`).notNull(),
    )
    .execute()

  // Nonce cache (replay prevention for service auth JWTs)
  await db.schema
    .createTable('nonce_cache')
    .addColumn('jti', 'text', (col) => col.primaryKey())
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .execute()

  await db.schema
    .createIndex('idx_nonce_cache_expires')
    .on('nonce_cache')
    .columns(['expires_at'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('nonce_cache').ifExists().execute()
  await db.schema.dropTable('groups').ifExists().execute()
}
```

#### Per-Group Migration (SQLite)

```typescript
// src/db/migrations/group/001_initial.ts
import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Membership
  await db.schema
    .createTable('group_members')
    .addColumn('member_did', 'text', (col) => col.primaryKey())
    .addColumn('role', 'text', (col) => col.notNull()) // member, admin, owner
    .addColumn('added_by', 'text', (col) => col.notNull())
    .addColumn('added_at', 'text', (col) =>
      col.defaultTo(sql`datetime('now')`).notNull(),
    )
    .execute()

  // Record authorship tracking
  await db.schema
    .createTable('group_record_authors')
    .addColumn('record_uri', 'text', (col) => col.primaryKey())
    .addColumn('author_did', 'text', (col) => col.notNull())
    .addColumn('collection', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) =>
      col.defaultTo(sql`datetime('now')`).notNull(),
    )
    .execute()

  await db.schema
    .createIndex('idx_record_authors_author')
    .on('group_record_authors')
    .columns(['author_did'])
    .execute()

  // Audit log
  await db.schema
    .createTable('group_audit_log')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('actor_did', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('collection', 'text')
    .addColumn('rkey', 'text')
    .addColumn('result', 'text', (col) => col.notNull()) // permitted, denied
    .addColumn('detail', 'text') // JSON string
    .addColumn('jti', 'text')
    .addColumn('created_at', 'text', (col) =>
      col.defaultTo(sql`datetime('now')`).notNull(),
    )
    .execute()

  await db.schema
    .createIndex('idx_audit_log_created')
    .on('group_audit_log')
    .columns(['created_at'])
    .execute()

  await db.schema
    .createIndex('idx_audit_log_actor')
    .on('group_audit_log')
    .columns(['actor_did'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('group_audit_log').ifExists().execute()
  await db.schema.dropTable('group_record_authors').ifExists().execute()
  await db.schema.dropTable('group_members').ifExists().execute()
}
```

### GroupDbPool

```typescript
// src/db/group-db-pool.ts
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { GroupDatabase } from './schema'

export class GroupDbPool {
  private dbs = new Map<string, Kysely<GroupDatabase>>()

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
  }

  get(groupDid: string): Kysely<GroupDatabase> {
    const existing = this.dbs.get(groupDid)
    if (existing) return existing

    const safeName = groupDid.replace(/[^a-zA-Z0-9_]/g, '_')
    const dbPath = join(this.dataDir, `${safeName}.sqlite`)

    const sqliteDb = new Database(dbPath)
    sqliteDb.pragma('journal_mode = WAL')
    sqliteDb.pragma('busy_timeout = 5000')

    const db = new Kysely<GroupDatabase>({
      dialect: new SqliteDialect({ database: sqliteDb }),
    })

    this.dbs.set(groupDid, db)
    return db
  }

  /** Run per-group migrations on a newly opened database */
  async migrateGroup(groupDid: string): Promise<void> {
    const db = this.get(groupDid)
    // Run SQLite migrations for this group's database
    // (uses the same Kysely Migrator pattern but with group migration files)
    await runGroupMigrations(db)
  }

  async destroyAll(): Promise<void> {
    for (const db of this.dbs.values()) {
      await db.destroy()
    }
    this.dbs.clear()
  }
}
```

### Permission Matrix

```typescript
// src/rbac/permissions.ts

export type Role = 'member' | 'admin' | 'owner'

export type Operation =
  | 'createRecord'
  | 'uploadBlob'
  | 'deleteOwnRecord'
  | 'deleteAnyRecord'
  | 'putOwnRecord'        // putRecord on a record the caller authored
  | 'putRecord:profile'   // putRecord on the group profile (singleton)
  | 'member.add'
  | 'member.remove'
  | 'member.list'
  | 'role.set'
  | 'audit.query'

export const ROLE_HIERARCHY: Record<Role, number> = {
  member: 0,
  admin: 1,
  owner: 2,
}

const MIN_ROLE_FOR_OPERATION: Record<Operation, Role> = {
  createRecord: 'member',
  uploadBlob: 'member',
  deleteOwnRecord: 'member',
  putOwnRecord: 'member',
  'member.list': 'member',
  deleteAnyRecord: 'admin',
  'putRecord:profile': 'admin',
  'member.add': 'admin',
  'member.remove': 'admin',
  'audit.query': 'admin',
  'role.set': 'owner',
}

export function canPerform(userRole: Role, operation: Operation): boolean {
  const requiredLevel = ROLE_HIERARCHY[MIN_ROLE_FOR_OPERATION[operation]]
  const userLevel = ROLE_HIERARCHY[userRole]
  return userLevel >= requiredLevel
}
```

### Error Classes

`AuthRequiredError` is exported by `@atproto/xrpc-server`. Define `UnauthorizedError` and `ForbiddenError` as thin `XRPCError` subclasses to keep handler code readable:

```typescript
// src/errors.ts
import { XRPCError } from '@atproto/xrpc-server'

export class UnauthorizedError extends XRPCError {
  constructor(message = 'Unauthorized') { super(401, 'Unauthorized', message) }
}

export class ForbiddenError extends XRPCError {
  constructor(message = 'Forbidden') { super(403, 'Forbidden', message) }
}
```

### RBAC Check Implementation

```typescript
// src/rbac/check.ts
import { Kysely } from 'kysely'
import { canPerform, ROLE_HIERARCHY, type Operation, type Role } from './permissions'
import { UnauthorizedError, ForbiddenError } from '../errors'
import type { GroupDatabase } from '../db/schema'

export class RbacChecker {
  async assertCan(
    groupDb: Kysely<GroupDatabase>,
    memberDid: string,
    operation: Operation,
  ): Promise<Role> {
    const member = await groupDb
      .selectFrom('group_members')
      .select('role')
      .where('member_did', '=', memberDid)
      .executeTakeFirst()

    if (!member) {
      throw new UnauthorizedError('Not a member of this group')
    }

    const role = member.role as Role
    if (ROLE_HIERARCHY[role] === undefined) {
      throw new Error(`Invalid role in database: ${role}`)
    }
    if (!canPerform(role, operation)) {
      throw new ForbiddenError(
        `Role '${role}' cannot perform '${operation}'`,
      )
    }

    return role
  }

  async isAuthor(
    groupDb: Kysely<GroupDatabase>,
    recordUri: string,
    memberDid: string,
  ): Promise<boolean> {
    const record = await groupDb
      .selectFrom('group_record_authors')
      .select('author_did')
      .where('record_uri', '=', recordUri)
      .executeTakeFirst()

    return record?.author_did === memberDid
  }
}
```

### Authorship Tracking

After a successful `createRecord` call to the group's PDS, insert into `group_record_authors`:

```typescript
// In createRecord handler, after group PDS write succeeds:
const groupDb = ctx.groupDbs.get(groupDid)
await groupDb.insertInto('group_record_authors').values({
  record_uri: response.data.uri, // at://did:plc:XXX/collection/rkey
  author_did: callerDid,
  collection: input.collection,
}).execute()
```

For `putRecord` on a new record (no existing authorship row), also insert authorship. For `deleteRecord`, remove the authorship row after group PDS delete succeeds.

### Handler Routing for Delete and Put

The `deleteRecord` handler must decide between `deleteOwnRecord` and `deleteAnyRecord`. Similarly, `putRecord` must decide between `putOwnRecord` and `putRecord:profile`.

```typescript
// In deleteRecord handler:
const groupDb = ctx.groupDbs.get(groupDid)
const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`
const isAuthor = await ctx.rbac.isAuthor(groupDb, recordUri, callerDid)
const operation = isAuthor ? 'deleteOwnRecord' : 'deleteAnyRecord'
await ctx.rbac.assertCan(groupDb, callerDid, operation)

// In putRecord handler:
const groupDb = ctx.groupDbs.get(groupDid)
const isProfileUpdate = input.collection === 'app.bsky.actor.profile' && input.rkey === 'self'
if (isProfileUpdate) {
  await ctx.rbac.assertCan(groupDb, callerDid, 'putRecord:profile')
} else {
  // For non-profile putRecord, check if caller authored the original record.
  // If no authorship row exists, this is a new record — treat it like createRecord.
  const recordUri = `at://${groupDid}/${input.collection}/${input.rkey}`
  const authorRow = await groupDb
    .selectFrom('group_record_authors')
    .select('author_did')
    .where('record_uri', '=', recordUri)
    .executeTakeFirst()
  if (authorRow) {
    // Existing record — only the original author can update
    if (authorRow.author_did !== callerDid) {
      throw new ForbiddenError('Can only update records you created')
    }
    await ctx.rbac.assertCan(groupDb, callerDid, 'putOwnRecord')
  } else {
    // New record — same permission as createRecord
    await ctx.rbac.assertCan(groupDb, callerDid, 'createRecord')
  }
}
```

### Audit Logging on Denied Requests

RBAC failures throw errors before the audit log call. Use the `xrpcHandler` wrapper from `src/api/util.ts` (see "AppContext & Shared Handler Pattern" section) to ensure all handlers follow the same auth->execute->audit lifecycle. Within each handler, wrap the RBAC check to log denials:

```typescript
// Pattern for all handlers (inside the xrpcHandler callback):
const groupDb = ctx.groupDbs.get(groupDid)
try {
  await ctx.rbac.assertCan(groupDb, callerDid, operation)
} catch (err) {
  // Only log structured metadata — never log full record bodies (may contain PII or large blobs)
  await ctx.audit.log(groupDb, callerDid, operation, 'denied', { reason: err.message })
  throw err
}
// ... execute operation ...
await ctx.audit.log(groupDb, callerDid, operation, 'permitted', { collection, rkey })
```

**Important**: The `AuditLogger` class (in `src/audit.ts`) should encapsulate the `group_audit_log` INSERT so the column mapping lives in one place, not scattered across handlers.

**Retention**: The `group_audit_log` table will grow indefinitely. Add a periodic cleanup (similar to nonce cleanup) that deletes entries older than a configurable retention period. See open question about audit log retention policy.

### Membership Safeguards

**`member.remove`**:
1. **Cannot remove owner**: Check if target's role is `owner` -> throw `CannotRemoveOwner`
2. **Cannot remove equal/higher role**: An admin cannot remove another admin. Check `ROLE_HIERARCHY[callerRole] > ROLE_HIERARCHY[targetRole]`, unless `callerDid === targetDid` (self-removal is always allowed).

**`member.add`**:
1. **Cannot assign equal/higher role**: An admin can add members, but not other admins. Check `ROLE_HIERARCHY[callerRole] > ROLE_HIERARCHY[assignedRole]`. Only owners can add admins.
2. **Validate `memberDid` format**: Reject DIDs that don't match `did:plc:*` or `did:web:*` patterns before inserting into the database. Use `@atproto/syntax` `ensureValidDid()` for parsing.

**`role.set`**:
1. **Last-owner protection**: Before demoting an owner, count remaining owners. If count === 1 and target is that owner, throw `LastOwnerDemotion`. This prevents irrecoverable states.
2. **Cannot promote above own role**: Check `ROLE_HIERARCHY[callerRole] >= ROLE_HIERARCHY[newRole]`. An owner can set any role; no one else should be able to create owners.

### Cursor Pagination

Both `member.list` and `audit.query` use cursor-based pagination. Use the primary key as cursor:

- **`member.list`**: Cursor = `added_at::member_did` (timestamp + DID for uniqueness). Query: `WHERE (added_at, member_did) > (cursor_ts, cursor_did) ORDER BY added_at, member_did LIMIT $limit`.
- **`audit.query`**: Cursor = `id` (integer primary key, monotonically increasing). Query: `WHERE id < $cursor ORDER BY id DESC LIMIT $limit` (newest-first).

Encode cursors as opaque base64 strings so the format can change without breaking clients.

---

## Encrypted App Password Storage

```typescript
// src/pds/credentials.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export function encrypt(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  // Format: iv (12) + authTag (16) + ciphertext (variable)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

export function decrypt(encoded: string, masterKey: Buffer): string {
  const data = Buffer.from(encoded, 'base64')
  const iv = data.subarray(0, IV_LENGTH)
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
```

The 256-bit master key is stored as `ENCRYPTION_KEY` env var (64 hex characters). Generated once with `crypto.randomBytes(32).toString('hex')`.

**Key rotation (post-MVP):** Add a `key_version` column to the `groups` table. To rotate: generate a new key -> re-encrypt all passwords with the new key -> swap the `ENCRYPTION_KEY` env var -> deploy. Not critical for PoC.

---

## Configuration

```typescript
// src/config.ts
import { z } from 'zod'

export const configSchema = z.object({
  // Server
  port: z.coerce.number().default(3000),
  publicHostname: z.string(), // e.g., group-service.example.com

  // SQLite data directory (global database + per-group databases)
  dataDir: z.string().default('./data'),

  // Encryption
  encryptionKey: z.string().length(64), // 256-bit hex

  // DID resolution
  plcUrl: z.string().default('https://plc.directory'),
  didCacheTtlMs: z.coerce.number().default(300_000), // 5 minutes

  // Blob limits
  maxBlobSize: z.coerce.number().default(10 * 1024 * 1024), // 10MB

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof configSchema>

export function loadConfig(): Config {
  return configSchema.parse({
    port: process.env.PORT,
    publicHostname: process.env.PUBLIC_HOSTNAME,
    dataDir: process.env.DATA_DIR,
    encryptionKey: process.env.ENCRYPTION_KEY,
    plcUrl: process.env.PLC_URL,
    didCacheTtlMs: process.env.DID_CACHE_TTL_MS,
    maxBlobSize: process.env.MAX_BLOB_SIZE,
    logLevel: process.env.LOG_LEVEL,
  })
}
```

### `.env.example`

```env
PORT=3000
PUBLIC_HOSTNAME=group-service.example.com

# Directory for all SQLite files (global.sqlite + per-group files)
# Must be on a persistent volume in Railway
DATA_DIR=./data

# 256-bit encryption key for app passwords (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY=

# DID resolution
PLC_URL=https://plc.directory
DID_CACHE_TTL_MS=300000

# Max blob upload size in bytes (default 10MB)
MAX_BLOB_SIZE=10485760

LOG_LEVEL=info
```

---

## Hosting & Deployment (Ultra-Specific)

### Recommended Stack: Everything on Railway

Railway hosts the entire stack: Group Service and the group's PDS — all in one project. All data (global SQLite + per-group SQLite files) lives on a single persistent volume. Railway has a [community-contributed Bluesky PDS template](https://railway.com/deploy/xBNJ1u) (by mkizka) that deploys `ghcr.io/bluesky-social/pds:0.4` with a persistent volume. No separate VPS needed. Note: the PDS image does not auto-update on Railway — you must redeploy manually to pick up new patch versions.

| Component | Provider | Plan | Monthly Cost |
|-----------|----------|------|-------------|
| **Group Service** | Railway (Pro) | ~1 vCPU, 512MB-1GB + volume | ~$7-10/mo |
| **Group's PDS** | Railway (Pro) | `ghcr.io/bluesky-social/pds:0.4` + volume | ~$5-7/mo |
| **Domain** | Porkbun (registrar) + Cloudflare (DNS) | .com | ~$1/mo |
| **Total** | | | **~$13-18/mo** |

Railway Pro is $20/mo which includes $20 of usage credit. At low traffic, everything may fit within that credit. Usage rates: ~$0.000463/hr per vCPU, ~$0.000232/hr per GB RAM. Volumes: $0.25/GB/mo.

**Why everything on Railway:**
- One platform, one dashboard, one bill — no juggling providers
- No external database to manage — everything is SQLite on a persistent volume
- Private networking between services (`*.railway.internal`) — the Group Service talks to the group's PDS over the internal network, zero latency, no public internet round-trip
- GitHub integration — push to `main` and the Group Service auto-deploys
- Railway handles TLS automatically on custom domains
- Community PDS template uses the official `ghcr.io/bluesky-social/pds` image — known-good configuration

### Railway Project Structure

Railway organizes things into **projects** with **services** inside them. Our project has four services:

```
Railway Project: "group-pds"
├── Service: "group-service"    ← Node.js app (from GitHub repo)
│   └── Volume: /app/data       ← global.sqlite + per-group SQLite files (persistent)
└── Service: "pds"              ← Official PDS Docker image (from template)
    └── Volume: /pds            ← SQLite DB + blob storage (persistent)
```

### Railway Deployment

#### 1. Deploy the Group's PDS First

Use the community Railway PDS template:

1. Go to [railway.com/deploy/xBNJ1u](https://railway.com/deploy/xBNJ1u)
2. Click **Deploy** — this creates a new project with the PDS service pre-configured
3. Set the required variables:
   - `PDS_HOSTNAME` = `pds.example.com`
   - `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` = generate with:
     ```bash
     openssl ecparam -name secp256k1 -genkey -noout | openssl ec -text -noout 2>/dev/null | grep priv -A 3 | tail -n +2 | tr -d '[:space:]:' | head -c 64
     ```
4. **CRITICAL**: Save the rotation key somewhere safe (password manager). This is the key that controls the group account's DID. You need it for PLC operations (adding the `#group_service` service entry) and for credible exit.
5. Configure optional variables (email SMTP for account verification, etc.)
6. Add a custom domain: Railway dashboard -> PDS service -> **Settings** -> **Networking** -> **Custom Domain** -> `pds.example.com`
7. Add the CNAME in Cloudflare DNS

Once deployed, create the group account:
```bash
# Create account via the PDS admin API
curl -X POST https://pds.example.com/xrpc/com.atproto.server.createAccount \
  -H "Content-Type: application/json" \
  -d '{
    "email": "group@example.com",
    "handle": "mygroup.pds.example.com",
    "password": "STRONG_PRIMARY_PASSWORD_SAVE_THIS"
  }'

# Log in to get a session token
curl -X POST https://pds.example.com/xrpc/com.atproto.server.createSession \
  -H "Content-Type: application/json" \
  -d '{"identifier": "mygroup.pds.example.com", "password": "STRONG_PRIMARY_PASSWORD_SAVE_THIS"}'
# → returns { "accessJwt": "...", "did": "did:plc:XXXXX", ... }

# Create an app password for the Group Service
curl -X POST https://pds.example.com/xrpc/com.atproto.server.createAppPassword \
  -H "Authorization: Bearer ACCESS_JWT_FROM_ABOVE" \
  -H "Content-Type: application/json" \
  -d '{"name": "group-service"}'
# → returns { "name": "group-service", "password": "xxxx-xxxx-xxxx-xxxx" }
# Save this app password — it goes into the Group Service's ENCRYPTION_KEY-encrypted storage
```

#### 2. Add the Group Service to the Same Project

In the Railway dashboard for the project created by the PDS template:

- Click **"+ New"** -> **"GitHub Repo"** -> select your `group-service` repo -> this becomes the Group Service

#### 3. Configure the Group Service

In Railway dashboard -> "group-service" service -> **Variables**:

```env
PORT=3000
PUBLIC_HOSTNAME=group-service.example.com
DATA_DIR=/app/data
ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
PLC_URL=https://plc.directory
DID_CACHE_TTL_MS=300000
LOG_LEVEL=info
```

**Important**: Add a persistent volume mounted at `/app/data` for the Group Service. This is where global.sqlite and per-group SQLite files are stored. Without a persistent volume, all data is lost on redeploy.

**Note on PDS URL**: The Group Service talks to the group's PDS. Since both are on Railway's private network, the Group Service can reach the PDS via its internal URL (e.g., `pds.railway.internal:3000`) for lower latency. However, for credible exit the group's PDS must also be publicly accessible — which it is via its custom domain. The Group Service should use the **public URL** (`https://pds.example.com`) for PDS writes so the same app password session works identically whether the service is on Railway or anywhere else.

#### 4. railway.toml

```toml
# railway.toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 10
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

#### 5. Dockerfile

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Prune devDependencies for the production image
RUN pnpm prune --prod

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN mkdir -p /app/data/groups
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

#### 6. Deploy

```bash
# From the repo root — pushes to Railway
railway up

# Or just push to GitHub — Railway auto-deploys from main
git push origin main
```

#### 7. Custom Domains

In Railway dashboard -> each service -> **Settings** -> **Networking** -> **Custom Domain**:

| Service | Custom Domain |
|---------|--------------|
| PDS (group's PDS) | `pds.example.com` |
| Group Service | `group-service.example.com` |

Railway gives you a CNAME target for each (e.g., `xxx-production-xxxx.up.railway.app`). Add these in Cloudflare DNS.

#### 8. Run Migrations

Global SQLite migrations run at server startup (in `main()` before `app.listen()`), so they execute automatically on every deploy. Per-group SQLite migrations run on first access to each group's database (in `GroupDbPool.get()`).

### DNS Setup (Cloudflare)

| Record | Name | Value | Proxy |
|--------|------|-------|-------|
| CNAME | `pds` | `pds-production-xxxx.up.railway.app` | DNS only (grey cloud) |
| CNAME | `group-service` | `group-service-production-xxxx.up.railway.app` | DNS only |
| TXT | `_atproto.mygroup` | `did=did:plc:XXXXX` | N/A |

**Important**: Do NOT enable Cloudflare proxy (orange cloud) for the PDS or Group Service. Railway handles TLS, and Cloudflare proxy can interfere with WebSocket connections and XRPC streaming.

---

## AppContext & Shared Handler Pattern

Every handler follows the same lifecycle: authenticate -> RBAC check -> execute -> audit log. To avoid repeating this in every file (and risking omission in new handlers), define a shared `AppContext` type and a handler wrapper.

### AppContext Type

```typescript
// src/context.ts
import type { Kysely } from 'kysely'
import type { Logger } from 'pino'
import type { Config } from './config'
import type { GlobalDatabase } from './db/schema'
import type { GroupDbPool } from './db/group-db-pool'
import type { AuthVerifier } from './auth/verifier'
import type { RbacChecker } from './rbac/check'
import type { PdsAgentPool } from './pds/agent'
import type { AuditLogger } from './audit'

export interface AppContext {
  config: Config
  globalDb: Kysely<GlobalDatabase>
  groupDbs: GroupDbPool
  authVerifier: AuthVerifier
  rbac: RbacChecker
  pdsAgents: PdsAgentPool
  audit: AuditLogger
  logger: Logger
}
```

### Handler Wrapper

```typescript
// src/api/util.ts
import type { Request, Response, NextFunction } from 'express'
import type { AppContext } from '../context'

/**
 * Wraps an XRPC handler with auth verification and structured error mapping.
 * All handlers get `{ callerDid, groupDid }` pre-verified.
 * Errors are caught and mapped to proper XRPC error responses.
 */
export function xrpcHandler(
  ctx: AppContext,
  fn: (req: Request, res: Response, auth: { callerDid: string; groupDid: string }) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { iss: callerDid, aud: groupDid } = await ctx.authVerifier.verify(req)
      await fn(req, res, { callerDid, groupDid })
    } catch (err) {
      next(err) // falls through to the XRPC error middleware below
    }
  }
}
```

### XRPC Error Middleware

Register this after all routes. It maps known error types to XRPC-shaped JSON responses and prevents Express from leaking stack traces.

```typescript
// src/api/error-handler.ts — register as the last middleware
// XRPCError is exported by @atproto/xrpc-server (also used in uploadBlob and agent pool)
import { XRPCError } from '@atproto/xrpc-server'
import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'

export function xrpcErrorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof XRPCError) {
      res.status(err.status).json({ error: err.name, message: err.message })
      return
    }
    logger.error(err, 'Unhandled error')
    res.status(500).json({ error: 'InternalServerError', message: 'Internal server error' })
  }
}
```

This ensures consistent error responses across all handlers and prevents silent omissions when adding new endpoints.

### Database Schema Types

```typescript
// src/db/schema.ts
import type { Generated, ColumnType } from 'kysely'

/** Global tables stored in global.sqlite */
export interface GlobalDatabase {
  groups: GroupsTable
  nonce_cache: NonceCacheTable
}

/** Per-group tables stored in SQLite (one file per group) */
export interface GroupDatabase {
  group_members: GroupMembersTable
  group_record_authors: GroupRecordAuthorsTable
  group_audit_log: GroupAuditLogTable
}

interface GroupsTable {
  did: string
  pds_url: string
  encrypted_app_password: string
  created_at: Generated<string>
}

interface NonceCacheTable {
  jti: string
  expires_at: string
}

interface GroupMembersTable {
  member_did: string
  role: string
  added_by: string
  added_at: Generated<string>
}

interface GroupRecordAuthorsTable {
  record_uri: string
  author_did: string
  collection: string
  created_at: Generated<string>
}

interface GroupAuditLogTable {
  id: Generated<number>
  actor_did: string
  action: string
  collection: string | null
  rkey: string | null
  result: string
  detail: string | null
  jti: string | null
  created_at: Generated<string>
}
```

---

## Server Entrypoint

```typescript
// src/index.ts
import express from 'express'
import { IdResolver } from '@atproto/identity'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config'
import { AuthVerifier } from './auth/verifier'
import { NonceCache } from './auth/nonce'
import { RbacChecker } from './rbac/check'
import { registerRoutes } from './api'
import { xrpcErrorHandler } from './api/error-handler'
import { runGlobalMigrations } from './db/migrate'
import { GroupDbPool } from './db/group-db-pool'
import { PdsAgentPool } from './pds/agent'
import { AuditLogger } from './audit'
import type { AppContext } from './context'
import type { GlobalDatabase } from './db/schema'

async function main() {
  const config = loadConfig()
  const logger = pino({ level: config.logLevel })

  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true })

  // Global database (SQLite)
  const sqliteDb = new Database(join(config.dataDir, 'global.sqlite'))
  sqliteDb.pragma('journal_mode = WAL')
  sqliteDb.pragma('busy_timeout = 5000')
  const globalDb = new Kysely<GlobalDatabase>({
    dialect: new SqliteDialect({ database: sqliteDb }),
  })

  // Run global SQLite migrations on startup
  await runGlobalMigrations(globalDb)
  logger.info('Global migrations complete')

  // Per-group SQLite databases
  const groupDbs = new GroupDbPool(join(config.dataDir, 'groups'))

  // DID resolution
  const idResolver = new IdResolver({ plcUrl: config.plcUrl })

  // Load managed group DIDs from database and initialize their SQLite DBs
  // NOTE: This set is loaded once at startup. Adding a new group requires a restart
  // (or a future admin endpoint that calls groupDids.add()). Fine for MVP.
  const groups = await globalDb.selectFrom('groups').select('did').execute()
  const groupDids = new Set(groups.map((g) => g.did))

  // Initialize per-group SQLite databases (runs migrations on first access)
  for (const groupDid of groupDids) {
    await groupDbs.migrateGroup(groupDid)
  }
  logger.info({ groups: groupDids.size }, 'Per-group databases initialized')

  // Auth & RBAC
  const nonceCache = new NonceCache(globalDb)

  // Periodic nonce cleanup (every 60 seconds)
  const nonceCleanupInterval = setInterval(() => nonceCache.cleanup().catch(logger.error), 60_000)
  const authVerifier = new AuthVerifier(idResolver, nonceCache, groupDids)
  const rbac = new RbacChecker()

  // Express app
  const app = express()

  // Trust Railway's reverse proxy so req.ip reflects the real client IP
  app.set('trust proxy', 1)

  app.use(pinoHttp({ logger }))

  // IMPORTANT: Do NOT use express.json() globally — it would consume the raw body
  // needed by uploadBlob. Instead, apply JSON parsing per-route or use a path exclusion.
  // Explicit 1MB limit to prevent oversized JSON payloads on non-blob endpoints.
  app.use((req, res, next) => {
    if (req.path === '/xrpc/com.atproto.repo.uploadBlob') return next()
    express.json({ limit: '1mb' })(req, res, next)
  })

  // Health check — verifies DB connectivity so Railway can detect stalled instances
  app.get('/health', async (_req, res) => {
    try {
      await globalDb.selectFrom('groups').select('did').limit(1).execute()
      res.json({ status: 'ok' })
    } catch {
      res.status(503).json({ status: 'error', message: 'database unreachable' })
    }
  })

  // XRPC routes — pass a typed AppContext to all handlers
  const pdsAgents = new PdsAgentPool(globalDb, Buffer.from(config.encryptionKey, 'hex'))
  const audit = new AuditLogger()
  const ctx: AppContext = { config, globalDb, groupDbs, authVerifier, rbac, pdsAgents, audit, logger }
  registerRoutes(app, ctx)

  // Error middleware (must be registered AFTER routes)
  app.use(xrpcErrorHandler(logger))

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, groups: groupDids.size }, 'Group Service started')
  })

  // Graceful shutdown — Railway sends SIGTERM before stopping containers
  const shutdown = async () => {
    logger.info('Shutting down...')
    clearInterval(nonceCleanupInterval)
    server.close()
    await groupDbs.destroyAll() // close all SQLite connections
    await globalDb.destroy()    // close global SQLite
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
```

---

## Multi-Group Support

One Group Service instance manages multiple group accounts. Each group:
- Has its own `did:plc` on its own PDS (or shared PDS)
- Has its own `#group_service` service entry pointing to this Group Service
- Has its own row in the `groups` table (global SQLite) with encrypted app password
- Has its own SQLite file with membership, audit log, and authorship tracking

The Group Service disambiguates by the `aud` claim in the service auth JWT.

### PDS Agent Pool

```typescript
// src/pds/agent.ts
import { Agent } from '@atproto/api'
import { XRPCError } from '@atproto/xrpc-server'
import { decrypt } from './credentials'
import type { Kysely } from 'kysely'
import type { GlobalDatabase } from '../db/schema'

export class PdsAgentPool {
  private agents = new Map<string, Agent>()
  private pending = new Map<string, Promise<Agent>>()

  constructor(
    private db: Kysely<GlobalDatabase>,
    private encryptionKey: Buffer,
  ) {}

  /** Remove a cached agent (e.g., on auth failure) to force re-login */
  invalidate(groupDid: string): void {
    this.agents.delete(groupDid)
  }

  async get(groupDid: string): Promise<Agent> {
    const existing = this.agents.get(groupDid)
    if (existing) return existing

    // Use a pending promise to prevent concurrent login() calls for the same group.
    // Without this, two simultaneous requests would both trigger login().
    const pending = this.pending.get(groupDid)
    if (pending) return pending

    const promise = this._login(groupDid)
    this.pending.set(groupDid, promise)
    try {
      const agent = await promise
      this.agents.set(groupDid, agent)
      return agent
    } finally {
      this.pending.delete(groupDid)
    }
  }

  private async _login(groupDid: string): Promise<Agent> {
    const group = await this.db
      .selectFrom('groups')
      .select(['pds_url', 'encrypted_app_password'])
      .where('did', '=', groupDid)
      .executeTakeFirstOrThrow()

    const appPassword = decrypt(group.encrypted_app_password, this.encryptionKey)

    const agent = new Agent(group.pds_url)
    await agent.login({
      identifier: groupDid,
      password: appPassword,
    })

    return agent
  }

  /**
   * Execute a callback with the agent for a group, retrying once on auth errors.
   * This handles the case where an app password was rotated and the cached agent is stale.
   * Handlers should use this instead of calling get() directly.
   */
  async withAgent<T>(groupDid: string, fn: (agent: Agent) => Promise<T>): Promise<T> {
    const agent = await this.get(groupDid)
    try {
      return await fn(agent)
    } catch (err: unknown) {
      // If the error is an auth failure (401, ExpiredToken), invalidate and retry once
      if (err instanceof XRPCError && (err.status === 401 || err.error === 'ExpiredToken')) {
        this.invalidate(groupDid)
        const freshAgent = await this.get(groupDid)
        return await fn(freshAgent)
      }
      throw err
    }
  }
}
```

---

## Credible Exit

### Setup (Owner Retains Control)

1. Owner creates account on the group's PDS with a strong primary password
2. Owner retains the primary password and recovery email
3. An app password is created (named `group-service`)
4. The Group Service stores only the app password (AES-256-GCM encrypted)
5. A PLC operation adds the `#group_service` service entry

### Exit Process

1. Log in directly to the group's PDS with primary password
2. Revoke the `group-service` app password -> Group Service loses write access
3. Optionally: PLC operation removing `#group_service` -> no PDS will proxy anymore
4. Account is now a normal single-user account on the PDS
5. All data persists, federation continues

### What the Owner Loses on Exit

- RBAC layer
- Audit log (export via `app.certified.group.audit.query` before exit)
- Membership records (export via `app.certified.group.member.list` before exit)

---

## Relationship to Your Web App

Your web app is just one client of the Group Service.

**Recommendation: Option A — Group Service is the source of truth for membership.**

Your web app calls `app.certified.group.member.add` / `app.certified.group.member.remove` via `atproto-proxy` when admins manage membership. If your web app uses Better Auth for its own user accounts, that's fine — but group membership canonical state lives in the Group Service's per-group SQLite. Any other app can query and manage membership via the same `app.certified.group.*` lexicons.

---

## Open Questions (With Recommendations)

### 1. Service entry type
The `CertifiedGroupService` type is custom. The PDS doesn't validate service types — it just needs a resolvable URL at that fragment ID. **Ship it as `CertifiedGroupService` and propose standardization later.** This is exactly what labelers did with `AtprotoLabeler`.

### 2. Multiple Group Services per account
Technically possible with different fragment IDs (`#group_service_a`, `#group_service_b`), but adds client complexity. **Start with one and revisit if needed.**

### 3. Read operations
Reads go directly to the group's PDS or AppView. The Group Service is write-only. **No changes needed.**

### 4. Handle changes on exit
If the handle is on the group's PDS domain (e.g., `mygroup.pds.example.com`), it works after exit. Custom domains require the owner to maintain DNS. **Document this in onboarding.**

### 5. App password deprecation
When Bluesky moves to OAuth-only, the Group Service would authenticate to the group's PDS via OAuth instead of app passwords. The architecture stays the same — only the credential type changes. **Build with app passwords now, plan for OAuth migration later.**

---

## Implementation Order

Steps are grouped into **MVP** (required for a working system) and **Post-MVP** (important but deferrable).

### MVP — Core functionality

1. **Scaffold** — Project setup, TypeScript config, Dockerfile, railway.toml
2. **Database** — Kysely + SQLite setup (global.sqlite + per-group SQLite), migrations, schema types, `GroupDbPool`
3. **Credentials** — AES-256-GCM app password encryption, PDS agent pool. *Dependency: required by all handlers that write to the group's PDS.*
4. **Auth** — Service JWT verifier (copy Ozone pattern), nonce cache. Must accept standard `com.atproto.repo.*` NSIDs and custom `app.certified.group.*` NSIDs.
5. **RBAC** — Permission matrix, membership queries (via per-group SQLite), authorship tracking
6. **Error middleware** — XRPC error handler, `xrpcHandler` wrapper. *Dependency: all handlers use the wrapper and error middleware.*
7. **Core API** — `com.atproto.repo.createRecord`, `deleteRecord`, `putRecord` handlers (intercept standard NSIDs, validate `repo` matches `aud`, use agent pool from step 3)
8. **Blob proxy** — `com.atproto.repo.uploadBlob` handler (buffered)
9. **Membership API** — `member.add`, `member.remove`, `member.list`, `role.set`
10. **Audit** — `AuditLogger` class + `audit.query` endpoint
11. **PLC tooling** — Script to add `#group_service` service entry to group DID document. *Deployment prerequisite: without this, no PDS will proxy requests to the Group Service.*
12. **Deploy** — Railway (group's PDS first, then Group Service in same project, persistent volume for SQLite)
13. **Integration test** — End-to-end: client -> PDS proxy -> Group Service -> group's PDS

### Post-MVP — Harden and polish

14. **Rate limiting** — Per-DID in-memory rate limiter (see open question). Low effort, high value for abuse prevention.
15. **Collection allowlist** — Per-group `allowed_collections` enforcement (see open question). Prevents members from writing to dangerous collections like `app.bsky.graph.block`.
16. **Audit retention** — Periodic cleanup of old audit log entries (see open question).

---

## Composability With Standard atproto SDKs

This architecture composes fully with the standard atproto stack. From a client's perspective:

```typescript
const groupClient = userAgent.withProxy('group_service', GROUP_DID)

// Standard typed SDK methods work out of the box — no custom lexicon code needed for CRUD
await groupClient.com.atproto.repo.createRecord({
  repo: GROUP_DID,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'Posted by a group member',
    createdAt: new Date().toISOString(),
  },
})

// Group management uses custom lexicons via .call()
await groupClient.call('app.certified.group.member.add', {}, {
  memberDid: 'did:plc:newmember',
  role: 'member',
})
```

`withProxy` is a standard `@atproto/api` method. It sets the `atproto-proxy` header. The user's PDS sees that header, resolves the group's DID doc, finds the `#group_service` service endpoint, signs a service auth JWT, and forwards the request. The client doesn't even know where the Group Service lives — it's resolved via the DID document.

Any atproto client that supports `withProxy` can talk to the Group Service without custom code: third-party Bluesky clients, CLI tools, bots. They just need the group's DID and the service fragment ID (`#group_service`). This is exactly how Ozone labeling works from third-party clients today.
