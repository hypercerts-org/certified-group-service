# Integration Guide

This guide walks you through integrating the group service into your app. By the end you'll be able to register a group, add members, and create records — all in about 50 lines of code.

## Service URLs and DID

```text
SERVICE_URL = https://dev.groups.certified.app
SERVICE_DID  = did:web:dev.groups.certified.app
```

The group service DID is always `did:web:<hostname>` — derived from the service URL. For any deployment, strip the scheme and use the hostname: `https://example.com` → `did:web:example.com`.

All example code below uses these constants:

```typescript
const GROUP_SERVICE = 'https://dev.groups.certified.app'
const GROUP_SERVICE_DID = 'did:web:dev.groups.certified.app'
```

## Architecture: where your app fits

The current reference integration uses **direct calls to the configured CGS URL**:

```text
Your App (BFF server)
    │
    │  1. User logs in via OAuth → you get an access token
    │  2. Your BFF asks the user's PDS for a service-auth JWT
    │  3. Your BFF calls the configured CGS URL with that JWT
    ▼
Group Service ──▶ Group's PDS
```

This direct path is currently preferred because service proxying depends on DID-document discovery. Immediately after `group.register`, the group DID document may be cached before the separate PLC operation that adds the `certified_group` service entry has propagated. A direct call uses the configured `GROUP_SERVICE_URL`, sends `aud` equal to the CGS service DID, and targets the group with `repo`, so it avoids that PDS DID-document cache race.

Service proxying remains supported as an optional path. It is useful when you want the user's PDS to forward requests, but it must resolve the appropriate DID document and service entry. The demo's BFF uses direct CGS calls for normal requests; see [Direct service calls](#direct-service-calls-recommended-current-path).

## Custom lexicons: why `app.certified.group.repo.*`

The group service uses **custom NSIDs** for record operations instead of the standard `com.atproto.repo.*`:

| Operation       | NSID to use                             |
| --------------- | --------------------------------------- |
| Create a record | `app.certified.group.repo.createRecord` |
| Update a record | `app.certified.group.repo.putRecord`    |
| Delete a record | `app.certified.group.repo.deleteRecord` |
| Upload a blob   | `app.certified.group.repo.uploadBlob`   |

**Why use the custom NSIDs?** When using service proxying, the user's PDS recognizes standard `com.atproto.repo.*` methods as local operations. Custom NSIDs such as `app.certified.group.repo.createRecord` make the PDS route the request to the group service instead. This distinction matters for the optional proxy path.

For direct calls to the CGS URL, the service accepts both the custom NSIDs and the registered `com.atproto.repo.*` aliases. The examples below use the custom NSIDs consistently so the same request shape works if you later switch to service proxying.

> **Proxy callers:** use `app.certified.group.repo.*` for writes. Standard `com.atproto.repo.*` writes will normally be handled by the user's PDS rather than forwarded to CGS.

The custom lexicons are JSON files shipped with the group service under `lexicons/app/certified/`. You must load them into your proxy agent so the `@atproto/api` client recognizes them. See Step 2 below.

## Step 1: Set up the group account

There are two equal alternatives: have CGS create a new account with `group.register`, or create the account separately and bring it under CGS management with `group.import`. Choose between them based primarily on who should _initially_ control the underlying PDS account.

The CGS `owner` role controls membership and permissions **inside CGS**. It does not necessarily identify the person who controls the underlying account:

| Control point                     | 1a: CGS creates the account with `group.register`                                                                                                                                                               | 1b: An existing account is added with `group.import`                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting point                    | CGS provisions a new DID, handle, and repo on the group's PDS.                                                                                                                                                  | The account holder has already created the DID, handle, and repo.                                                                                                                                                          |
| Account email                     | A non-deliverable placeholder is used by default. A real recovery email is used only if supplied during registration.                                                                                           | The existing account's email and recovery arrangements remain under the account holder's control.                                                                                                                          |
| Primary account password          | CGS generates one internally to create the account, but does **not** currently return it to the owner.                                                                                                          | The existing account holder retains the full password.                                                                                                                                                                     |
| Credential held by CGS            | CGS creates and stores an app password.                                                                                                                                                                         | The account holder supplies CGS with an app password and can revoke it at any time.                                                                                                                                        |
| Recovery/rotation key held by CGS | CGS generates and retains the recovery key; it is not currently delivered to the owner.                                                                                                                         | None. CGS never receives the existing account's recovery or rotation keys.                                                                                                                                                 |
| Effective account-level control   | Without a real recovery email, CGS is the only party among the group participants holding usable account credentials. CGS controls the account-level access path, while its owner and admins govern membership. | The holder of the account's email/full password remains the ultimate controller, even if a different DID is assigned the CGS `owner` role. They can recover the account or revoke CGS's app password independently of CGS. |

The intended account-control model for groups created through `group.register` is to support transferring **full control of the underlying PDS account** to the group's CGS owner. This is distinct from merely assigning the CGS `owner` role: the handoff must give that person control of the underlying account's recovery and primary credentials. After such a transfer, the result may be effectively the same as if the owner had created the account themselves and then imported it: the owner ultimately controls the account, while CGS operates through delegated, revocable credentials. This full account-control transfer is not yet supported, so clients must not present the CGS `owner` role as proof of underlying account ownership today.

Both alternatives are **service-scoped** calls: they target the service itself (`aud` = the service DID), not an existing group. This guide invokes them **non-proxied** (the client calls the group service directly), which is the simplest approach. The per-group calls in later steps go through the proxy agent instead.

### Step 1a: Register a new account through CGS

Registration requires a **service auth JWT** proving the caller controls the `ownerDid`. Your BFF obtains this from the user's PDS via `com.atproto.server.getServiceAuth`, then forwards it to the group service.

```typescript
async function registerGroup(agent: AtpAgent, handle: string, ownerDid: string, email?: string) {
  // Get a service auth JWT from the user's PDS to prove DID control.
  // aud = the group service DID; lxm = the registration endpoint NSID.
  const {
    data: { token },
  } = await agent.com.atproto.server.getServiceAuth({
    aud: GROUP_SERVICE_DID,
    lxm: 'app.certified.group.register',
  })

  const res = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
- `ownerDid` — the DID of the user who will own this group within CGS. Must match the JWT's `iss` claim. They're immediately seeded with the CGS `owner` role.
- `email` — optional recovery email for the group account. If omitted, a placeholder is generated. Providing a real email enables the forgot-password flow, but does not yet constitute the full account-control transfer described above.

### Step 1b: Import an existing account

If the account already exists — e.g. a Bluesky/atproto account you want to "promote" to a group rather than creating a fresh one — use `app.certified.group.import`. It reuses the existing DID, handle, and repo.

The JWT must be signed by **the account being imported** (`groupDid`), not by the prospective owner: the service authenticates the account granting itself to the group (the grantor), and an app password alone cannot produce that signature. So `agent` below is an authenticated session for the `groupDid` account.

```typescript
async function importGroup(
  agent: AtpAgent, // an authenticated session for the groupDid account
  groupDid: string,
  appPassword: string,
  ownerDid: string,
) {
  const {
    data: { token },
  } = await agent.com.atproto.server.getServiceAuth({
    aud: GROUP_SERVICE_DID,
    lxm: 'app.certified.group.import',
  })

  const res = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ groupDid, appPassword, ownerDid }),
  })

  if (!res.ok) throw new Error(`Import failed: ${res.status}`)

  // Response: { groupDid: "did:plc:abc123", handle: "existing.pds.example.com" }
  return res.json()
}
```

- `groupDid` — the DID of the existing account to import. The group service resolves its PDS and handle from the DID document.
- `appPassword` — an [app password](https://bsky.app/settings/app-passwords) for that account, so the service can act on its behalf. Stored encrypted; the account holder manages its lifecycle and can revoke it at any time to sever the service's access.
- `ownerDid` — the DID seeded with the CGS `owner` role. Unlike the JWT issuer (which must be `groupDid`), `ownerDid` is **not** separately authenticated and may differ from `groupDid`: the imported account can hand CGS governance to a different DID without transferring the underlying account credentials. The recipient is not asked to opt in, so validate it client-side before importing.

Import does **not** modify the account's DID document. Service proxying is not currently relied upon, and an app password cannot perform the PLC operation required to add a service entry. See `docs/design/group-import.md`.

## Step 2: Choose direct calls or optional service proxying

For the current recommended path, keep the CGS URL configured and call it directly with service-auth JWTs; the complete pattern appears in [Direct service calls](#direct-service-calls-recommended-current-path). If you choose service proxying, create a proxy agent with the custom lexicons as follows.

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
  // Optional proxy path. withProxy sets the atproto-proxy header so the PDS
  // forwards to the group service. The legacy target resolves the group's DID
  // document and is vulnerable to the post-registration cache race described above.
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

> **Proxying caveat:** this example uses the legacy `aud` path. Because
> `withProxy('certified_group', groupDid)` routes through the **group's** DID document,
> it can fail immediately after registration if the user's PDS has cached the
> pre-registration document. It also mints the deprecated group-DID `aud` form.
> If you use proxying, target the **service** DID instead —
> `withProxy('certified_group_service', cgsServiceDid)` — and send an explicit
> `repo` to name the group. See [Migrating from the legacy `aud` form (#27)](#migrating-from-the-legacy-aud-form-27).
> Do **not** add `repo` while staying on the legacy proxy target: for a query, `repo`
> present with `aud` = group DID is a hard `401`. `repo` and the service-DID `aud`
> must change together.

## Step 3: Make authenticated requests

With a `groupAgent` configured, call group service endpoints. Use the custom `app.certified.group.repo.*` NSIDs for record operations (the PDS needs these to route correctly), and the `app.certified.group.*` NSIDs for member/role/audit operations.

Every group-scoped method names its target group with an explicit **`repo`**
field — an `at-identifier` (a handle **or** a DID). For JSON-body procedures
(`createRecord`, `putRecord`, `deleteRecord`, `member.add`, `member.remove`,
`role.set`) `repo` goes in the **body**; for query methods (`member.list`,
`audit.query`) and the raw/body-less methods (`repo.uploadBlob`, `group.destroy`)
it goes in the **querystring** (`?repo=<handle-or-did>`). This is exactly what a
stock `@atproto/api` typed call already emits.

> **Targeting a group (#27):** the group is identified by the `repo` field above,
> and the supported form sets the JWT `aud` to the **service DID**. The older form —
> group taken from the JWT `aud` with no `repo` — is **deprecated but still accepted**.
> The proxy agent in Step 2 as written (`withProxy('certified_group', groupDid)`) lands
> on the legacy path (it mints `aud` = the group DID), so the examples below carry a
> `Deprecation` header; switch the proxy target to the service DID
> (`withProxy('certified_group_service', cgsServiceDid)`) to put them on the supported
> path. The `repo` and the service-DID `aud` go together — for a query, `repo` with a
> group-DID `aud` is a hard `401`, not a partially-migrated call. See
> [Migrating from the legacy `aud` form (#27)](#migrating-from-the-legacy-aud-form-27)
> and `docs/design/aud-deprecation.md`.

```typescript
// Add a member (returns { memberDid, role, addedBy, addedAt })
// repo names the target group, in the body for this JSON procedure.
const { data: member } = await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { repo: groupDid, memberDid: 'did:plc:newmember', role: 'member' },
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

**Important:** The `repo` field **is** the group selector — the service resolves
it to a DID and routes the request to that group. A `repo` that names no
registered group is rejected with `401 Unknown group`. (`repo` accepts a handle
or a DID; `groupDid` above is a DID, but the group's handle works too.)

## Putting it all together

Here's a complete flow — register a group, add a member, create a post:

```typescript
import { AtpAgent } from '@atproto/api'

// 1. Set up an agent authenticated to the user's PDS
const agent = new AtpAgent({ service: userPdsUrl })
// ... configure agent with user's OAuth session

// 2. Register a group (non-proxied call — proves DID control via service auth)
const { groupDid } = await registerGroup(agent, 'our-team', currentUserDid)

// 3. Set up the proxy agent with custom lexicons
const groupAgent = createGroupAgent(agent, groupDid)

// 4. Add a member (requires admin or owner role)
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { repo: groupDid, memberDid: 'did:plc:newmember', role: 'member' },
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

Use the custom `app.certified.group.repo.uploadBlob` NSID. The request body is the
raw blob bytes, so the target group is named by `repo` in the **querystring** (the
first argument to `.call`) rather than the body:

```typescript
// Upload a blob (5 MB by default; configurable via MAX_BLOB_SIZE) — repo in the querystring, body is the raw bytes
const {
  data: { blob },
} = await groupAgent.call('app.certified.group.repo.uploadBlob', { repo: groupDid }, imageBuffer, {
  encoding: 'image/png',
})

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
const {
  data: { records },
} = await groupAgent.com.atproto.repo.listRecords({
  repo: groupDid,
  collection: 'app.bsky.feed.post',
  limit: 50,
})
```

These are standard AT Protocol read operations — no authentication is required beyond what the PDS needs to resolve the proxy target. Any `com.atproto.repo.*` read works here because the PDS recognizes these as reads and proxies them, unlike writes which the PDS handles locally (see [Custom lexicons](#custom-lexicons-why-appcertifiedgrouprepo) above).

## Writing records

All write operations go through the group service, which enforces RBAC and logs to the audit trail. Each write carries a `repo` field (in the request body) naming the target group — a handle or DID, resolved to the group DID server-side; a `repo` that names no registered group is rejected with `401 Unknown group`.

### createRecord

**NSID:** `app.certified.group.repo.createRecord`
**Required role:** member

Creates a new record in the group's repository. Tracks the caller as author (used for delete permissions later).

### putRecord

**NSID:** `app.certified.group.repo.putRecord`
**Required role:** depends on context

| Scenario                                                         | Required role |
| ---------------------------------------------------------------- | ------------- |
| Creating new record (no existing author)                         | member        |
| Updating a record you authored                                   | member        |
| Updating another member's record                                 | admin         |
| Editing the group profile (`app.bsky.actor.profile` rkey `self`) | admin         |

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

The target group is named by the `repo` field. `member.list` is a query, so
`repo` goes in the **querystring** (the first argument to `.call`); the
`member.add` / `member.remove` / `role.set` procedures take it in the **body**.

```typescript
// List members (any member can do this) — repo in the querystring
const {
  data: { members, cursor },
} = await groupAgent.call('app.certified.group.member.list', { repo: groupDid, limit: 50 })
// members: [{ did, role, addedBy, addedAt }, ...]

// Add a member (requires admin)
// Returns: { memberDid, role, addedBy, addedAt }
await groupAgent.call(
  'app.certified.group.member.add',
  {},
  { repo: groupDid, memberDid: 'did:plc:newmember', role: 'member' },
  { encoding: 'application/json' },
)

// Remove a member (requires admin, or any role for self-removal)
await groupAgent.call(
  'app.certified.group.member.remove',
  {},
  { repo: groupDid, memberDid: 'did:plc:targetmember' },
  { encoding: 'application/json' },
)

// Change a member's role (requires owner)
// role can be 'member' or 'admin' (role.set cannot change an owner)
await groupAgent.call(
  'app.certified.group.role.set',
  {},
  { repo: groupDid, memberDid: 'did:plc:trustedmember', role: 'admin' },
  { encoding: 'application/json' },
)
```

## Querying the audit log

Every action (permitted or denied) is logged. Admins and owners can query the
audit log for their group. `audit.query` is a query method, so `repo` (the
target group) goes in the querystring alongside any filters.

```typescript
// All recent entries
const {
  data: { entries },
} = await groupAgent.call('app.certified.group.audit.query', { repo: groupDid })

// Filter by actor
const {
  data: { entries: userEntries },
} = await groupAgent.call('app.certified.group.audit.query', {
  repo: groupDid,
  actorDid: 'did:plc:specificuser',
})

// Filter by action
const {
  data: { entries: deletions },
} = await groupAgent.call('app.certified.group.audit.query', {
  repo: groupDid,
  action: 'deleteOwnRecord',
})

// Filter by collection
const {
  data: { entries: postEntries },
} = await groupAgent.call('app.certified.group.audit.query', {
  repo: groupDid,
  collection: 'app.bsky.feed.post',
})
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

## Removing a group

The owner can remove a group from the service with `app.certified.group.destroy`.
It has **no request body**, so — like `uploadBlob` — the target group is named by
`repo` in the **querystring**.

```typescript
// Destroy the group (requires owner) — repo in the querystring
// Returns: { groupDid }
await groupAgent.call('app.certified.group.destroy', { repo: groupDid })
```

This is the service-level inverse of `register` / `import`: it drops the group's stored credentials, its membership, and its per-group data from the service. It deliberately does **not** touch the underlying PDS account — the DID, handle, records, and blobs continue to exist and stay publicly readable. Destroy is therefore _not_ account or data deletion; if you also want to tear down the account, do that separately against its PDS.

Destroy is **lossy and irreversible** — plan for it before calling:

- **Export the audit log first if you need it.** `app.certified.group.audit.query` works only while the group lives; destroy deletes the audit log along with the rest of the per-group data. The destroy itself is not written to that log (it is deleted in the same step) — only to the service's operational log.
- **Re-import resurrects the account, not the group's history.** Because the account survives, you can `app.certified.group.import` it later, but the re-imported group starts with an empty authorship table. Records still on the PDS become unowned, so the first member to `putRecord` a surviving `rkey` is recorded as its author and can overwrite it.
- **Clean up the DID document and app password yourself.** For `register`-created groups the `certified_group` entry in the DID document is left in place — remove it as the DID controller if you no longer want requests routed to the service. The stored app password is likewise not revoked at the PDS (the service cannot); revoke it directly against the account if that matters.

## Error handling

The group service returns standard XRPC errors:

| Status | Meaning                        | What to do                                                          |
| ------ | ------------------------------ | ------------------------------------------------------------------- |
| 400    | Bad request (validation error) | Check your request body — the `message` field explains what's wrong |
| 401    | Authentication failed          | Session is invalid or expired. Re-authenticate and retry            |
| 403    | Forbidden (insufficient role)  | The user doesn't have the required role for this operation          |
| 404    | Not found                      | Member or record doesn't exist                                      |
| 409    | Conflict                       | Member already exists, or handle already taken                      |

All error responses follow this shape:

```json
{
  "error": "ErrorName",
  "message": "Human-readable description"
}
```

## Complete endpoint reference

| NSID                                            | Type      | Required role | Description                                                       |
| ----------------------------------------------- | --------- | ------------- | ----------------------------------------------------------------- |
| `app.certified.group.register`                  | procedure | service auth  | Register a new group (non-proxied call)                           |
| `app.certified.group.import`                    | procedure | service auth  | Import an existing account as a group (direct)                    |
| `app.certified.group.repo.createRecord`         | procedure | member        | Create a record                                                   |
| `app.certified.group.repo.putRecord`            | procedure | member/admin  | Update or create a record                                         |
| `app.certified.group.repo.deleteRecord`         | procedure | member/admin  | Delete a record                                                   |
| `app.certified.group.repo.uploadBlob`           | procedure | member        | Upload a blob (5 MB by default; configurable via `MAX_BLOB_SIZE`) |
| `app.certified.group.member.add`                | procedure | admin         | Add a member                                                      |
| `app.certified.group.member.remove`             | procedure | admin/self    | Remove a member                                                   |
| `app.certified.group.member.list`               | query     | member        | List members with pagination                                      |
| `app.certified.group.role.set`                  | procedure | owner         | Change a member's role                                            |
| `app.certified.group.destroy`                   | procedure | owner         | Remove the group from the service                                 |
| `app.certified.group.audit.query`               | query     | admin         | Query the audit log                                               |
| `app.certified.group.ownershipTransfer.propose` | procedure | owner         | Propose an ownership transfer                                     |
| `app.certified.group.ownershipTransfer.accept`  | procedure | member\*      | Accept an ownership transfer                                      |
| `app.certified.group.ownershipTransfer.cancel`  | procedure | member\*      | Cancel an ownership transfer                                      |
| `app.certified.group.ownershipTransfer.status`  | query     | member        | Check ownership-transfer status                                   |
| `app.certified.group.keys.create`               | procedure | member        | Mint a scoped API key                                             |
| `app.certified.group.keys.list`                 | query     | member        | List API keys visible to the caller                               |
| `app.certified.group.keys.delete`               | procedure | member        | Revoke an API key                                                 |
| `app.certified.groups.membership.list`          | query     | service auth  | List the caller's groups on this service                          |
| `app.certified.group.admin.setOwner`            | procedure | HTTP Basic    | Operator ownership reassignment                                   |

## Role quick reference

Roles are **per-group**, not global. A user can be an owner of one group, a member of another, and not part of a third. Every permission check is scoped to a single group — the one named by the request's `repo` field (legacy callers still name it via the JWT's `aud` claim; see [#27 migration](#migrating-from-the-legacy-aud-form-27)).

| Role       | Can do (within that group)                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| _(anyone)_ | Read records (`getRecord`, `listRecords`) — reads go to the PDS, not the group service                       |
| **member** | Create records, edit/delete own records, upload blobs, list members                                          |
| **admin**  | Everything above + edit/delete any member's records, edit group profile, add/remove members, query audit log |
| **owner**  | Everything above + change member/admin roles and initiate ownership transfer                                 |

Key constraints:

- Admins can add members at `member` or `admin` level — but not at or above their own role
- Admins can remove members below their own role level
- Any member can remove themselves (self-removal)
- `member.remove` and `role.set` cannot remove, demote, or otherwise change an owner
- `member.add` and `role.set` can only assign `member` or `admin`; the owner role cannot be assigned through those endpoints
- Ownership transfer is a separate propose/accept flow; `accept` requires a DID-authenticated JWT, not an API key. The operator-only `admin.setOwner` endpoint can also reassign ownership, demoting the previous owner.
- API-key-authenticated callers cannot create, list, or revoke API keys; JWT-authenticated members can use those endpoints

`*` Ownership-transfer `accept` and `cancel` have a member role floor, but their handlers apply additional identity checks: only the proposed owner can accept, and only the current owner or proposed owner can cancel.

## Reference implementation

The [demo app](../demo/) is a complete working example with:

- OAuth login via `@atproto/oauth-client-node` ([`demo/server/oauth/client.ts`](../demo/server/oauth/client.ts))
- Direct CGS calls with service-auth JWTs ([`demo/server/oauth/proxy-agent.ts`](../demo/server/oauth/proxy-agent.ts))
- Optional proxy-agent setup with custom lexicons ([`demo/server/oauth/proxy-agent.ts`](../demo/server/oauth/proxy-agent.ts))
- BFF routes for group-service requests ([`demo/server/routes/proxy.ts`](../demo/server/routes/proxy.ts))
- Group registration ([`demo/server/routes/register.ts`](../demo/server/routes/register.ts))
- React frontend ([`demo/src/`](../demo/src/))

For the full API specification, see the [API Reference](./api-reference.md).

## Direct service calls (recommended current path)

For current integrations, call the configured group service URL directly. Fetch a
service-auth token via `com.atproto.server.getServiceAuth`, then send the request
with `Authorization: Bearer <jwt>`. This is the path used by the demo because it
avoids the PDS DID-document cache race that can occur after registration. Use the
custom `app.certified.group.repo.*` NSIDs — the `lxm` field in the JWT must match
the NSID you're calling.

Mint the JWT with `aud` = the **service DID** (its standard RFC 7519 meaning), and
name the target group with `repo` — in the body for JSON procedures, in the
querystring for queries / raw-body methods:

```typescript
// Mint a service-auth JWT for a group-scoped call.
// aud = the SERVICE DID (not the group DID); lxm = the NSID being called.
const {
  data: { token },
} = await agent.com.atproto.server.getServiceAuth({
  aud: GROUP_SERVICE_DID,
  lxm: 'app.certified.group.repo.createRecord',
})

// Procedure: repo travels in the body.
const res = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.repo.createRecord`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    repo: groupDid, // the group selector (a handle or DID)
    collection: 'app.bsky.feed.post',
    record: {
      $type: 'app.bsky.feed.post',
      text: 'First post from the group!',
      createdAt: new Date().toISOString(),
    },
  }),
})

// Query / raw-body method: repo travels in the querystring, e.g.
//   GET /xrpc/app.certified.group.member.list?repo=<handle-or-did>&limit=50
```

Service proxying remains available when its DID-document resolution path is suitable. It lets the user's PDS mint and forward the service-auth request, but it does not avoid the post-registration DID-document propagation/cache issue. Direct calls are the recommended current path for the reference integration.

## Migrating from the legacy `aud` form (#27)

Earlier the group service read the target group from the JWT `aud` claim — a misuse
of `aud`, whose RFC 7519 meaning is the **service** receiving the token, not the
resource acted on. That overload is now **deprecated** ([#27](https://github.com/hypercerts-org/certified-group-service/issues/27)).
Both forms are accepted during the migration window:

|                    | Legacy (deprecated)          | New (supported)     |
| ------------------ | ---------------------------- | ------------------- |
| Group named by     | JWT `aud`                    | explicit `repo`     |
| JWT `aud`          | the **group** DID            | the **service** DID |
| `repo` field       | absent                       | present             |
| Deprecation header | `Deprecation: true` + `Link` | none                |

A call must be **fully** one form or the other — `repo` and `aud` change together, and
a half-migrated mix is rejected (`401 jwt audience does not match service did`). The
examples in this guide already send `repo` and set `aud` to the service DID; under
proxying, target the service DID with `withProxy('certified_group_service', cgsServiceDid)`.

For the complete migration reference — the service-DID derivation, per-method `repo`
placement, the direct-vs-proxied details, and how to detect un-migrated calls — see
**[Migrating group targeting (`aud` → `repo`)](./aud-migration.md)**. For the design
rationale (unsigned `repo`, the resolution round-trip, security), see
[`design/aud-deprecation.md`](./design/aud-deprecation.md).

## API keys: long-lived backend access (#26)

A service-auth JWT is short-lived (≤ 2 minutes) and single-use — correct for
interactive, per-request access, but a poor fit for a **backend daemon** that wants
to poll group data indefinitely without holding a member's signing key. For that,
any group member can issue their own long-lived, scope-limited **API key**.

The flow (the platform backend-sync example):

1. **Member mints a key** (one-time, with that member's normal JWT). The plaintext is
   returned exactly once — store it in your backend secret store.

   ```typescript
   const { data } = await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.keys.create`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberJwt}` },
     body: JSON.stringify({
       repo: groupDid,
       name: 'platform backend',
       // Pass scopes by their friendly `rpc:<method>` name. The service binds
       // each to its own audience before storing — you don't supply an `aud`.
       scopes: ['rpc:app.certified.group.member.list'],
     }),
   }).then((r) => r.json())
   // data.key === 'cgsk_…'  ← store this now; it is never returned again
   // data.scopes === ['rpc:app.certified.group.member.list?aud=…']  ← canonical form
   ```

2. **Backend polls with the key** — `X-API-Key` instead of a JWT, the group named
   by `repo`. No login, no `getServiceAuth`, no 2-minute refresh, no owner
   credentials held by the backend.

   ```typescript
   const res = await fetch(
     `${GROUP_SERVICE}/xrpc/app.certified.group.member.list?repo=${groupDid}`,
     { headers: { 'X-API-Key': process.env.CGS_API_KEY! } },
   )
   ```

3. **Revoke if leaked** — `app.certified.group.keys.delete { repo, keyRef }`. The
   key is rejected on its next use.

A key is constrained by **both** its scopes and the current role of the member who issued it,
and can only reach operations it is scoped for. `keys.create` rejects scopes the caller's current role cannot use (for example, a plain member cannot mint an `audit.query` key). Demoting or removing that member automatically caps or disables their existing keys. A key can never manage keys.

**Writes, too.** Keys aren't read-only: scope a key with `repo:<collection>?action=create|update|delete` to create/update/delete records, or `blob:<accept>` (e.g. `blob:image/*`) to upload blobs. Write calls are procedures, so put `repo` on the **querystring** as well as in the body (API-key auth resolves the group before the body is parsed):

```typescript
await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.repo.createRecord?repo=${groupDid}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.CGS_API_KEY! },
  body: JSON.stringify({
    repo: groupDid,
    collection: 'app.bsky.feed.post',
    record: {
      /* … */
    },
  }),
})
```

A `repo:` scope picks the collection + action; the issuing member's **role** still decides whose records may be touched — a member-issued key can only mutate records that member authored (`repo:` scopes have no own-vs-any axis). Storing a narrowly-scoped key is far less sensitive than holding a member's signing key. See `docs/design/api-keys.md`.

### Permission sets: granting whole namespaces at once

Listing every `repo:<collection>?action=…` scope by hand is tedious and easy to get out of date. The Hypercerts and Certified record types are published as **permission sets** — named, reusable scope bundles you reference with a single `include:<nsid>` scope:

| Permission set             | Grants write (create/update/delete) on    |
| -------------------------- | ----------------------------------------- |
| `org.hypercerts.authWrite` | all `org.hypercerts.*` record collections |
| `app.certified.authWrite`  | all `app.certified.*` record collections  |

These are published in the [`hypercerts-lexicon`](https://github.com/hypercerts-org/hypercerts-lexicon) repo (the namespace authority), and are usable in **two** ways:

**1. As an OAuth scope (available now).** If your app reaches CGS through standard AT Protocol OAuth + service proxying, request the set as a scope in your authorization request and the user's PDS expands it for you:

```text
scope: include:org.hypercerts.authWrite
```

The user sees the set's plain-language description ("Manage your Hypercerts data") on the consent screen. An app that writes both Hypercerts and Certified records requests **both** `include:` scopes — a permission set may only reference its own namespace authority, so the two cannot be combined into one set.

**2. As an API-key scope.** `keys.create` accepts an `include:<nsid>` scope and expands it to the underlying `repo:` scopes at key-creation time (design: `docs/design/api-key-permission-sets.md`):

```typescript
await fetch(`${GROUP_SERVICE}/xrpc/app.certified.group.keys.create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerJwt}` },
  body: JSON.stringify({
    repo: groupDid,
    name: 'hypercerts backend',
    scopes: ['include:org.hypercerts.authWrite'],
  }),
})
// The returned (and stored) scopes are the EXPANDED concrete repo: scope(s);
// the include: itself is never stored. The set is resolved and frozen at
// create time, so re-issue the key to pick up a later change to the set.
```

If the set can't be resolved, the call fails with `400 InvalidScope` and no key is minted. You can still list concrete `repo:<collection>?action=…` scopes explicitly instead of using `include:`. Reading these records never needs a scope (or a permission set) at all — atproto repo records are public.
