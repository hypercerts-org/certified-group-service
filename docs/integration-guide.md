# Integration Guide

This guide walks you through integrating the group service into your app. By the end you'll be able to register a group, add members, and create records — all in about 50 lines of code.

## Staging environment

The group service staging instance is deployed at:

```
https://atproto-group-gate-staging.up.railway.app
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

## Step 1: Register a group

Registration requires a **service auth JWT** proving the caller controls the `ownerDid`. Your BFF obtains this from the user's PDS via `com.atproto.server.getServiceAuth`, then forwards it to the group service.

```typescript
const GROUP_SERVICE = 'https://atproto-group-gate-staging.up.railway.app'
const GROUP_SERVICE_DID = 'did:web:atproto-group-gate-staging.up.railway.app'

async function registerGroup(agent: AtpAgent, handle: string, ownerDid: string) {
  // Get a service auth JWT from the user's PDS to prove DID control
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
    body: JSON.stringify({ handle, ownerDid }),
  })

  if (!res.ok) throw new Error(`Registration failed: ${res.status}`)

  // { groupDid: "did:plc:abc123", handle: "mygroup.pds.example.com" }
  return res.json()
}
```

- `agent` — an `AtpAgent` authenticated to the user's PDS (with their OAuth session).
- `handle` — alphanumeric with hyphens (e.g. `"my-team"`). Gets suffixed with the PDS hostname automatically.
- `ownerDid` — the DID of the user who will own this group. Must match the JWT's `iss` claim. They're immediately seeded as the owner.

## Step 2: Create a proxy agent

With the group's DID in hand, create a proxy agent that routes all group service calls through the user's PDS:

```typescript
import { AtpAgent } from '@atproto/api'

// Create an agent authenticated to the user's PDS
const agent = new AtpAgent({ service: userPdsUrl })
// ... configure agent with user's OAuth session (access token, DPoP, etc.)

// Create a proxy agent for a specific group
const groupAgent = agent.withProxy('certified_group', groupDid)
```

All calls made through `groupAgent` will be forwarded by the PDS to the group service with proper service auth — you never touch the service auth JWTs directly.

> **Note:** If your PDS uses DPoP-bound tokens (e.g. via OAuth), you'll need a custom
> `fetchHandler` on the `AtpAgent` that attaches DPoP proofs. See the
> [demo app's dpop-fetch.ts](../demo/server/oauth/dpop-fetch.ts) for a complete implementation.

## Step 3: Make authenticated requests

With a `groupAgent` configured, call any group service endpoint using typed XRPC calls:

```typescript
// Add a member
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// Create a record
const post = await groupAgent.com.atproto.repo.createRecord({
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'First post from the group!',
    createdAt: new Date().toISOString(),
  },
})
// post.data.uri → "at://did:plc:abc123/app.bsky.feed.post/3xyz789"
```

## Putting it all together

Here's a complete flow — register a group, add a member, create a post:

```typescript
import { AtpAgent } from '@atproto/api'

// 1. Set up an agent authenticated to the user's PDS
const agent = new AtpAgent({ service: userPdsUrl })
// ... configure agent with user's OAuth session

// 2. Register a group (proves DID control via service auth)
const { groupDid } = await registerGroup(agent, 'our-team', currentUserDid)

// 3. Set up the proxy agent
const groupAgent = agent.withProxy('certified_group', groupDid)

// 4. Add a member (requires admin or owner role)
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// 5. Create a post in the group's repo
const post = await groupAgent.com.atproto.repo.createRecord({
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'First post from the group!',
    createdAt: new Date().toISOString(),
  },
})
// post.data.uri → "at://did:plc:abc123/app.bsky.feed.post/3xyz789"
```

## Uploading blobs

Use `groupAgent.com.atproto.repo.uploadBlob()` to upload images and other binary data:

```typescript
// Upload a blob
const { data: { blob } } = await groupAgent.com.atproto.repo.uploadBlob(imageBuffer, {
  encoding: 'image/png',
})

// Attach the blob to a post
await groupAgent.com.atproto.repo.createRecord({
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
})
```

Max blob size is 5 MB by default.

## Managing members and roles

```typescript
// List members (any member can do this)
const { data: { members, cursor } } = await groupAgent.call(
  'app.certified.group.member.list',
  { groupDid, limit: 50 },
)

// Remove a member (requires admin, or any role for self-removal)
await groupAgent.call(
  'app.certified.group.member.remove',
  {},
  { memberDid: 'did:plc:targetmember' },
  { encoding: 'application/json' },
)

// Promote a member to admin (requires owner)
await groupAgent.call(
  'app.certified.group.role.set',
  {},
  { memberDid: 'did:plc:trustedmember', role: 'admin' },
  { encoding: 'application/json' },
)
```

## Querying the audit log

Every action (permitted or denied) is logged. Admins and owners of the group can query its audit log — there's no cross-group view:

```typescript
// All recent entries
const { data: { entries } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { groupDid },
)

// Filter by actor
const { data: { entries: userEntries } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { groupDid, actorDid: 'did:plc:specificuser' },
)

// Filter by action
const { data: { entries: deletions } } = await groupAgent.call(
  'app.certified.group.audit.query',
  { groupDid, action: 'deleteRecord' },
)
```

## Error handling

The group service returns standard XRPC errors. Here's what to handle:

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

## Role quick reference

Roles are **per-group**, not global. A user can be an owner of one group, a member of another, and not part of a third. There are no platform-wide superusers — every permission check is scoped to a single group based on the JWT's `aud` claim.

| Role | Can do (within that group) |
|------|--------|
| **member** | Create records, edit any record, delete own records, upload blobs, list members |
| **admin** | Everything above + delete any record, edit group profile, add/remove members, query audit log |
| **owner** | Everything above + change member roles (promote/demote) |

Key constraints:
- Admins can't modify users at their own level or above
- `member.add` can only assign `member` or `admin` — not `owner`
- Any member can remove themselves
- The last owner can't be demoted

## Reference implementation

The [demo app](../demo/) is a complete working example with:
- OAuth login flow with DPoP ([`demo/server/oauth/`](../demo/server/oauth/))
- DPoP fetch handler for AtpAgent ([`demo/server/oauth/dpop-fetch.ts`](../demo/server/oauth/dpop-fetch.ts))
- BFF proxy via service proxying ([`demo/server/routes/proxy.ts`](../demo/server/routes/proxy.ts))
- Group registration ([`demo/server/routes/register.ts`](../demo/server/routes/register.ts))
- React frontend ([`demo/src/`](../demo/src/))

For the full API specification, see the [API Reference](./api-reference.md).

## Direct calls (advanced)

If you can't use service proxying (e.g. your environment doesn't support it), you can
still call the group service directly using `com.atproto.server.getServiceAuth` to obtain
a JWT and then making requests with `Authorization: Bearer <jwt>`. This is the legacy
approach — service proxying is preferred because it's simpler, more secure (the BFF never
touches service auth JWTs), and follows the standard atproto pattern.
