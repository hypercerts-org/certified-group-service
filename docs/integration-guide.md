# Integration Guide

This guide walks you through integrating the group service into your app. By the end you'll be able to register a group, add members, and create records — all in about 50 lines of code.

## Architecture: where your app fits

```
Your App (BFF server)
    │
    │  1. User logs in via OAuth → you get an access token
    │  2. You call getServiceAuth on the user's PDS → you get a signed JWT
    │  3. You forward requests to the group service with that JWT
    │
    ▼
Group Service ──▶ Group's PDS
```

Your app acts as a **backend-for-frontend (BFF)** that sits between your users and the group service. The group service never talks to your users directly — it only accepts server-to-server requests authenticated with atproto service auth JWTs.

## Step 1: Register a group

This is the only unauthenticated call. It creates a new account on the group's PDS and returns the group's DID.

```typescript
const GROUP_SERVICE = 'https://group-service.example.com'

async function registerGroup(handle: string, ownerDid: string) {
  const res = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, ownerDid }),
  })

  if (!res.ok) throw new Error(`Registration failed: ${res.status}`)

  // { groupDid: "did:plc:abc123", handle: "mygroup.pds.example.com", accountPassword: "..." }
  return res.json()
}
```

- `handle` — alphanumeric with hyphens (e.g. `"my-team"`). Gets suffixed with the PDS hostname automatically.
- `ownerDid` — the DID of the user who will own this group. They're immediately seeded as the owner.
- `accountPassword` — returned once. You don't need to store this; the group service manages its own credentials.

## Step 2: Get a service auth JWT

Every subsequent call requires a JWT signed by the user's PDS. You get this by calling `com.atproto.server.getServiceAuth` on the user's PDS using their OAuth access token.

```typescript
async function getServiceAuthToken(
  userPdsUrl: string,
  accessToken: string,
  groupDid: string,
  method: string, // e.g. "com.atproto.repo.createRecord"
): Promise<string> {
  const url = new URL('/xrpc/com.atproto.server.getServiceAuth', userPdsUrl)
  url.searchParams.set('aud', groupDid)
  url.searchParams.set('lxm', method)

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) throw new Error(`Service auth failed: ${res.status}`)

  const { token } = await res.json()
  return token
}
```

The returned JWT contains:
- `iss` — the user's DID (from their PDS)
- `aud` — the group's DID (what you passed as `aud`)
- `lxm` — the XRPC method (what you passed as `lxm`)
- `jti` — a unique nonce (set by the PDS)
- `exp` — expiration timestamp

> **Important:** Each JWT can only be used **once** — the group service tracks nonces and rejects replays. Get a fresh token for every request.

> **Note:** If your PDS uses DPoP-bound tokens (e.g. via OAuth), you'll need to include DPoP proofs with the `getServiceAuth` call. See the [demo app's service-auth.ts](../demo/server/oauth/service-auth.ts) for a complete DPoP implementation.

## Step 3: Make authenticated requests

With a JWT in hand, call any group service endpoint:

```typescript
async function groupServiceRequest(
  method: 'GET' | 'POST',
  nsid: string,
  jwt: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
) {
  const url = new URL(`/xrpc/${nsid}`, GROUP_SERVICE)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`${nsid} failed (${res.status}): ${err.message || JSON.stringify(err)}`)
  }

  return res.json()
}
```

## Putting it all together

Here's a complete flow — register a group, add a member, create a post:

```typescript
// 1. Register a group (owner is the current user)
const { groupDid } = await registerGroup('our-team', currentUserDid)

// 2. Add a member (requires admin or owner role)
const addMemberJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'app.certified.group.member.add',
)
await groupServiceRequest('POST', 'app.certified.group.member.add', addMemberJwt, {
  memberDid: 'did:plc:newmember',
  role: 'member',
})

// 3. Create a post in the group's repo
const createJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'com.atproto.repo.createRecord',
)
const post = await groupServiceRequest('POST', 'com.atproto.repo.createRecord', createJwt, {
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post',
    text: 'First post from the group!',
    createdAt: new Date().toISOString(),
  },
})
// post.uri → "at://did:plc:abc123/app.bsky.feed.post/3xyz789"
```

## Uploading blobs

Blob uploads use raw binary bodies instead of JSON:

```typescript
async function uploadBlob(
  jwt: string,
  groupDid: string,
  data: Buffer | Uint8Array,
  mimeType: string,
) {
  const res = await fetch(`${GROUP_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': mimeType,
      'Content-Length': String(data.byteLength),
    },
    body: data,
  })

  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)

  // { blob: { $type: "blob", ref: { $link: "bafyrei..." }, mimeType, size } }
  return res.json()
}

// Usage: upload an image, then attach it to a post
const uploadJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'com.atproto.repo.uploadBlob',
)
const { blob } = await uploadBlob(uploadJwt, groupDid, imageBuffer, 'image/png')

const createJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'com.atproto.repo.createRecord',
)
await groupServiceRequest('POST', 'com.atproto.repo.createRecord', createJwt, {
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
const listJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'app.certified.group.member.list',
)
const { members, cursor } = await groupServiceRequest(
  'GET', 'app.certified.group.member.list', listJwt,
  undefined,
  { groupDid, limit: '50' },
)

// Remove a member (requires admin, or any role for self-removal)
const removeJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'app.certified.group.member.remove',
)
await groupServiceRequest('POST', 'app.certified.group.member.remove', removeJwt, {
  memberDid: 'did:plc:targetmember',
})

// Promote a member to admin (requires owner)
const roleJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'app.certified.group.role.set',
)
await groupServiceRequest('POST', 'app.certified.group.role.set', roleJwt, {
  memberDid: 'did:plc:trustedmember',
  role: 'admin',
})
```

## Querying the audit log

Every action (permitted or denied) is logged. Admins and owners of the group can query its audit log — there's no cross-group view:

```typescript
const auditJwt = await getServiceAuthToken(
  userPdsUrl, accessToken, groupDid, 'app.certified.group.audit.query',
)

// All recent entries
const { entries } = await groupServiceRequest(
  'GET', 'app.certified.group.audit.query', auditJwt,
  undefined,
  { groupDid },
)

// Filter by actor
const { entries: userEntries } = await groupServiceRequest(
  'GET', 'app.certified.group.audit.query', auditJwt,
  undefined,
  { groupDid, actorDid: 'did:plc:specificuser' },
)

// Filter by action
const { entries: deletions } = await groupServiceRequest(
  'GET', 'app.certified.group.audit.query', auditJwt,
  undefined,
  { groupDid, action: 'deleteRecord' },
)
```

## Error handling

The group service returns standard XRPC errors. Here's what to handle:

| Status | Meaning | What to do |
|--------|---------|------------|
| 400 | Bad request (validation error) | Check your request body — the `message` field explains what's wrong |
| 401 | Authentication failed | JWT is invalid, expired, or replayed. Get a fresh one |
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
| **member** | Create records, edit/delete own records, upload blobs, list members |
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
- BFF proxy pattern ([`demo/server/routes/proxy.ts`](../demo/server/routes/proxy.ts))
- Group registration ([`demo/server/routes/register.ts`](../demo/server/routes/register.ts))
- React frontend ([`demo/src/`](../demo/src/))

For the full API specification, see the [API Reference](./api-reference.md).
