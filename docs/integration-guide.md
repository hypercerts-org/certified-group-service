# Integration Guide

This guide walks you through integrating the group service into your app. By the end you'll be able to register a group, add members, and create records — all in about 50 lines of code.

## Service URLs and DID

```
SERVICE_URL = https://atproto-group-gate-staging.up.railway.app
SERVICE_DID  = did:web:atproto-group-gate-staging.up.railway.app
```

The group service DID is always `did:web:<hostname>` — derived from the service URL. For any deployment, strip the scheme and use the hostname: `https://example.com` → `did:web:example.com`.

All example code below uses these constants:

```typescript
const GROUP_SERVICE = 'https://atproto-group-gate-staging.up.railway.app'
const GROUP_SERVICE_DID = 'did:web:atproto-group-gate-staging.up.railway.app'
```

## Architecture: where your app fits

```
Your App (BFF server)
    │
    │  1. User logs in via OAuth → you get an access token
    │  2. You send XRPC requests to the user's PDS with atproto-proxy header
    │  3. The PDS handles service auth and forwards to the group service
    │
    ▼
User's PDS ──▶ Group Service ──▶ Group's PDS
```

Your app acts as a **backend-for-frontend (BFF)** that sits between your users and the group service. Instead of managing service auth JWTs yourself, you send requests to the user's PDS with an `atproto-proxy` header — the PDS handles authentication and forwards requests to the group service on your behalf.

## Custom lexicons: why `app.certified.group.repo.*`

The group service uses **custom NSIDs** for record operations instead of the standard `com.atproto.repo.*`:

| Operation | NSID to use |
|---|---|
| Create a record | `app.certified.group.repo.createRecord` |
| Update a record | `app.certified.group.repo.putRecord` |
| Delete a record | `app.certified.group.repo.deleteRecord` |
| Upload a blob | `app.certified.group.repo.uploadBlob` |

**Why not `com.atproto.repo.*`?** The recommended integration pattern uses service proxying: your app sends requests to the user's PDS with an `atproto-proxy` header, and the PDS forwards them to the group service. When the PDS sees a `com.atproto.repo.createRecord` call, it handles it itself (writing to its own repo) — it has no reason to forward it anywhere. Custom NSIDs like `app.certified.group.repo.createRecord` are unrecognized by the PDS, so it looks up the target service in the group's DID document and proxies the request there. **This is the only way record operations can reach the group service through the proxy pattern.**

> **Do not use `com.atproto.repo.*` NSIDs.** They will never reach the group service when proxying through a PDS. The group service does accept them for backwards compatibility on direct calls, but direct calls are not the recommended pattern and the standard NSIDs may be removed in the future.

The custom lexicons are JSON files shipped with the group service under `lexicons/app/certified/`. You must load them into your proxy agent so the `@atproto/api` client recognizes them. See Step 2 below.

## Step 1: Register a group

Registration requires a **service auth JWT** proving the caller controls the `ownerDid`. Your BFF obtains this from the user's PDS via `com.atproto.server.getServiceAuth`, then forwards it to the group service.

```typescript
async function registerGroup(
  agent: AtpAgent,
  handle: string,
  ownerDid: string,
  email?: string,
) {
  // Get a service auth JWT from the user's PDS to prove DID control.
  // aud = the group service DID; lxm = the registration endpoint NSID.
  const { data: { token } } = await agent.com.atproto.server.getServiceAuth({
    aud: GROUP_SERVICE_DID,
    lxm: 'app.certified.group.register',
  })

  const res = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ handle, ownerDid, email }),
  })

  if (!res.ok) throw new Error(`Registration failed: ${res.status}`)

  // Response: { groupDid: "did:plc:abc123", handle: "mygroup.pds.example.com" }
  return res.json()
}
```

- `agent` — an `AtpAgent` authenticated to the user's PDS (with their OAuth session).
- `handle` — alphanumeric with hyphens (e.g. `"my-team"`). Gets suffixed with the PDS hostname automatically.
- `ownerDid` — the DID of the user who will own this group. Must match the JWT's `iss` claim. They're immediately seeded as the owner.
- `email` — optional recovery email for the group account. If omitted, a placeholder is generated. Providing a real email enables the forgot-password flow for credible exit.

Registration is the **only** endpoint called directly (not via proxy). All subsequent calls go through the proxy agent.

## Step 2: Create a proxy agent with custom lexicons

With the group's DID in hand, create a proxy agent that routes all group service calls through the user's PDS. You must also load the custom lexicons so the client knows about the `app.certified.group.repo.*` NSIDs.

```typescript
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { AtpAgent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'

// Load custom lexicons from the group service's lexicons/app/certified/ directory.
// Copy this directory into your project, or install the group service as a dependency.
function loadLexicons(dir: string): LexiconDoc[] {
  const docs: LexiconDoc[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      docs.push(...loadLexicons(fullPath))
    } else if (extname(entry.name) === '.json') {
      docs.push(JSON.parse(readFileSync(fullPath, 'utf8')))
    }
  }
  return docs
}

const customLexicons = loadLexicons('./lexicons/app/certified')

function createGroupAgent(agent: AtpAgent, groupDid: string): AtpAgent {
  // withProxy sets the atproto-proxy header so the PDS forwards to the group service.
  // The second arg is the group DID — the PDS resolves the group's DID document to
  // find the "certified_group" service endpoint, then routes requests there.
  const proxied = agent.withProxy('certified_group', groupDid) as AtpAgent

  // Register the custom lexicons so the client can call app.certified.group.repo.*
  for (const doc of customLexicons) {
    proxied.lex.add(doc)
  }

  return proxied
}

// Usage:
const agent = new AtpAgent({ service: userPdsUrl })
// ... configure agent with user's OAuth session (access token, DPoP, etc.)
const groupAgent = createGroupAgent(agent, groupDid)
```

> **Note:** If your PDS uses DPoP-bound tokens (e.g. via OAuth), use `@atproto/oauth-client-node`
> to manage sessions and create agents. See the [demo app's proxy-agent.ts](../demo/server/oauth/proxy-agent.ts)
> for a complete implementation that restores an OAuth session and creates a proxied agent.

## Step 3: Make authenticated requests

With a `groupAgent` configured, call group service endpoints. Use the custom `app.certified.group.repo.*` NSIDs for record operations (the PDS needs these to route correctly), and the `app.certified.group.*` NSIDs for member/role/audit operations.

```typescript
// Add a member (returns { memberDid, role, addedBy, addedAt })
const { data: member } = await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// Create a record — note the custom NSID, NOT com.atproto.repo.createRecord
const { data: post } = await groupAgent.call(
  'app.certified.group.repo.createRecord',
  {},
  {
    repo: groupDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'First post from the group!',
      createdAt: new Date().toISOString(),
    },
  },
  { encoding: 'application/json' },
)
// post.uri → "at://did:plc:abc123/app.bsky.feed.post/3xyz789"
```

**Important:** The `repo` field in all record operations must match the group DID. The group service rejects requests where `repo` doesn't match the JWT's `aud` claim.

## Putting it all together

Here's a complete flow — register a group, add a member, create a post:

```typescript
import { AtpAgent } from '@atproto/api'

// 1. Set up an agent authenticated to the user's PDS
const agent = new AtpAgent({ service: userPdsUrl })
// ... configure agent with user's OAuth session

// 2. Register a group (direct call — proves DID control via service auth)
const { groupDid } = await registerGroup(agent, 'our-team', currentUserDid)

// 3. Set up the proxy agent with custom lexicons
const groupAgent = createGroupAgent(agent, groupDid)

// 4. Add a member (requires admin or owner role)
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// 5. Create a post in the group's repo (requires member role)
const { data: post } = await groupAgent.call(
  'app.certified.group.repo.createRecord',
  {},
  {
    repo: groupDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'First post from the group!',
      createdAt: new Date().toISOString(),
    },
  },
  { encoding: 'application/json' },
)
// post.uri → "at://did:plc:abc123/app.bsky.feed.post/3xyz789"
```

## Uploading blobs

Use the custom `app.certified.group.repo.uploadBlob` NSID:

```typescript
// Upload a blob (max 5 MB)
const { data: { blob } } = await groupAgent.call(
  'app.certified.group.repo.uploadBlob',
  {},
  imageBuffer,
  { encoding: 'image/png' },
)

// Attach the blob to a post
await groupAgent.call(
  'app.certified.group.repo.createRecord',
  {},
  {
    repo: groupDid,
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'Check out this photo!',
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ alt: 'A photo', image: blob }],
      },
    },
  },
  { encoding: 'application/json' },
)
```

## Reading records

Reading records (`getRecord`, `listRecords`) does **not** go through the group service. The group's data lives on a real PDS, so reads go directly to that PDS using standard `com.atproto.repo.*` NSIDs — no RBAC, no custom lexicons, no group service involvement.

The PDS forwards `com.atproto.repo.getRecord` and `com.atproto.repo.listRecords` when an `atproto-proxy` header is present, so your proxy agent works for reads too:

```typescript
// Read a single record
const { data: record } = await groupAgent.com.atproto.repo.getRecord({
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  rkey: '3abc123',
})

// List records in a collection
const { data: { records } } = await groupAgent.com.atproto.repo.listRecords({
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  limit: 50,
})
```

These are standard AT Protocol read operations — no authentication is required beyond what the PDS needs to resolve the proxy target. Any `com.atproto.repo.*` read works here because the PDS recognizes these as reads and proxies them, unlike writes which the PDS handles locally (see [Custom lexicons](#custom-lexicons-why-appcertifiedgrouprepo) above).

## Writing records

All write operations go through the group service, which enforces RBAC and logs to the audit trail. The `repo` field must always match the group DID.

### createRecord

**NSID:** `app.certified.group.repo.createRecord`
**Required role:** member

Creates a new record in the group's repository. Tracks the caller as author (used for delete permissions later).

### putRecord

**NSID:** `app.certified.group.repo.putRecord`
**Required role:** depends on context

| Scenario | Required role |
|----------|---------------|
| Creating new record (no existing author) | member |
| Updating a record you authored | member |
| Updating another member's record | member |
| Editing the group profile (`app.bsky.actor.profile` rkey `self`) | admin |

```typescript
// Edit the group profile (admin only)
await groupAgent.call(
  'app.certified.group.repo.putRecord',
  {},
  {
    repo: groupDid,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: {
      $type: 'app.bsky.actor.profile',
      displayName: 'Our Group',
      description: 'A collaborative group account',
    },
  },
  { encoding: 'application/json' },
)
```

### deleteRecord

**NSID:** `app.certified.group.repo.deleteRecord`
**Required role:** member (own records), admin (any record)

```typescript
await groupAgent.call(
  'app.certified.group.repo.deleteRecord',
  {},
  {
    repo: groupDid,
    collection: 'app.bsky.feed.post',
    rkey: '3abc123',
  },
  { encoding: 'application/json' },
)
```

## Managing members and roles

The group DID is **not** passed as a parameter — it's inferred from the JWT's `aud` claim, which the proxy agent sets automatically.

```typescript
// List members (any member can do this)
const { data: { members, cursor } } = await groupAgent.call(
  'app.certified.group.member.list',
  { limit: 50 },
)
// members: [{ did, role, addedBy, addedAt }, ...]

// Add a member (requires admin)
// Returns: { memberDid, role, addedBy, addedAt }
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// Remove a member (requires admin, or any role for self-removal)
await groupAgent.call(
  'app.certified.group.member.remove',
  {},
  { memberDid: 'did:plc:targetmember' },
  { encoding: 'application/json' },
)

// Change a member's role (requires owner)
// role can be 'member', 'admin', or 'owner'
await groupAgent.call(
  'app.certified.group.role.set',
  {},
  { memberDid: 'did:plc:trustedmember', role: 'admin' },
  { encoding: 'application/json' },
)
```

## Querying the audit log

Every action (permitted or denied) is logged. Admins and owners can query the audit log for their group.

```typescript
// All recent entries
const { data: { entries } } = await groupAgent.call(
  'app.certified.group.audit.query',
  {},
)

// Filter by actor
const { data: { entries: userEntries } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { actorDid: 'did:plc:specificuser' },
)

// Filter by action
const { data: { entries: deletions } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { action: 'deleteOwnRecord' },
)

// Filter by collection
const { data: { entries: postEntries } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { collection: 'app.bsky.feed.post' },
)
```

Audit entries look like:
```json
{
  "id": "42",
  "actorDid": "did:plc:member1",
  "action": "member.add",
  "result": "permitted",
  "detail": { "memberDid": "did:plc:newmember", "role": "admin" },
  "createdAt": "2026-01-15T12:00:00.000Z"
}
```

For the full list of `action` values and what each `detail` object contains, see [Action values](./api-reference.md#action-values) in the API reference.

## Error handling

The group service returns standard XRPC errors:

| Status | Meaning | What to do |
|--------|---------|------------|
| 400 | Bad request (validation error) | Check your request body — the `message` field explains what's wrong |
| 401 | Authentication failed | Session is invalid or expired. Re-authenticate and retry |
| 403 | Forbidden (insufficient role) | The user doesn't have the required role for this operation |
| 404 | Not found | Member or record doesn't exist |
| 409 | Conflict | Member already exists, or handle already taken |

All error responses follow this shape:

```json
{
  "error": "ErrorName",
  "message": "Human-readable description"
}
```

## Complete endpoint reference

| NSID | Type | Required role | Description |
|------|------|---------------|-------------|
| `app.certified.group.register` | procedure | service auth | Register a new group (direct call, not proxied) |
| `app.certified.group.repo.createRecord` | procedure | member | Create a record |
| `app.certified.group.repo.putRecord` | procedure | member/admin | Update or create a record |
| `app.certified.group.repo.deleteRecord` | procedure | member/admin | Delete a record |
| `app.certified.group.repo.uploadBlob` | procedure | member | Upload a blob (max 5 MB) |
| `app.certified.group.member.add` | procedure | admin | Add a member |
| `app.certified.group.member.remove` | procedure | admin/self | Remove a member |
| `app.certified.group.member.list` | query | member | List members with pagination |
| `app.certified.group.role.set` | procedure | owner | Change a member's role |
| `app.certified.group.audit.query` | query | admin | Query the audit log |

## Role quick reference

Roles are **per-group**, not global. A user can be an owner of one group, a member of another, and not part of a third. Every permission check is scoped to a single group based on the JWT's `aud` claim.

| Role | Can do (within that group) |
|------|--------|
| *(anyone)* | Read records (`getRecord`, `listRecords`) — reads go to the PDS, not the group service |
| **member** | Create records, edit any record, delete own records, upload blobs, list members |
| **admin** | Everything above + delete any record, edit group profile, add/remove members, query audit log |
| **owner** | Everything above + change member roles (promote/demote to any level including owner) |

Key constraints:
- Admins can add members at `member` or `admin` level — but not at or above their own role
- Admins can remove members below their own role level
- Any member can remove themselves (self-removal)
- The last owner can't be demoted
- `member.add` can only assign `member` or `admin` — use `role.set` to promote to `owner`

## Reference implementation

The [demo app](../demo/) is a complete working example with:
- OAuth login via `@atproto/oauth-client-node` ([`demo/server/oauth/client.ts`](../demo/server/oauth/client.ts))
- Proxy agent creation with custom lexicons ([`demo/server/oauth/proxy-agent.ts`](../demo/server/oauth/proxy-agent.ts))
- BFF proxy via service proxying ([`demo/server/routes/proxy.ts`](../demo/server/routes/proxy.ts))
- Group registration ([`demo/server/routes/register.ts`](../demo/server/routes/register.ts))
- React frontend ([`demo/src/`](../demo/src/))

For the full API specification, see the [API Reference](./api-reference.md).

## Direct calls (advanced)

If you can't use service proxying (e.g. your environment doesn't support it), you can
call the group service directly by obtaining a JWT via `com.atproto.server.getServiceAuth`
and making requests with `Authorization: Bearer <jwt>`. Use the custom
`app.certified.group.repo.*` NSIDs — the `lxm` field in the JWT must match the NSID
you're calling.

Service proxying is preferred because it's simpler, more secure (the BFF never touches
service auth JWTs), and follows the standard atproto pattern.
