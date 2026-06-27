# Group Service Demo

A small reference app showing how to integrate with the
[Certified Group Service](../) (CGS) from a web app. It's a **React SPA** with a
thin **backend-for-frontend (BFF)** that logs the user in via AT Protocol OAuth
and forwards XRPC calls to the group service through the `atproto-proxy` pattern.

It is a teaching/demo app, not production code — but it exercises the real CGS
API end to end.

## What it demonstrates

Each page maps to part of the CGS surface:

| Page          | What it shows                                                                      |
|---------------|------------------------------------------------------------------------------------|
| **Login**     | AT Protocol OAuth against the ePDS; the BFF holds the session.                     |
| **Register**  | Create a group (`group.register`) or import an existing account.                   |
| **Dashboard** | The active group and your role in it.                                              |
| **Records**   | Create / update / delete records via `app.certified.group.repo.*`.                 |
| **Upload**    | Upload a blob to the group's repo.                                                 |
| **Audit**     | Query the group's audit log.                                                       |
| **API Keys**  | Mint scope-limited API keys, show the secret once, list/revoke, and **use** a key against any key-accessible XRPC. |

The **API Keys** page is the most complete example of the key framework: it mints
a key with a scope picker (`rpc:` scopes for service methods, `repo:` scopes for
record writes, and `blob:` scopes), shows the plaintext exactly once, and
lists/revokes keys. Its
**Use a key** box then **calls any key-accessible XRPC with the key via the
`X-API-Key` header** — no owner session — so you can watch a key work on its own
(and get a `403` when it lacks the scope). The method picker offers the methods a
key's scopes can actually authorize:

- `member.list` and `audit.query` — `rpc:`-scoped queries (with optional audit
  filters);
- `repo.createRecord` / `repo.putRecord` / `repo.deleteRecord` — `repo:`-scoped
  writes, proxied to the group's PDS.

JWT-only management methods (`keys.*`, `role.set`, `member.add`/`remove`, `group.register`)
carry no key scope and so are omitted; `uploadBlob` is omitted too, as it takes a
raw binary stream rather than a JSON body (use the **Upload** page for blobs).

## Architecture

```
Browser (React SPA, Vite)
   │  /api/*        → BFF
   ▼
BFF (Express, server/)
   │  OAuth session + atproto-proxy → user's PDS → Group Service
   │  /api/keys/call → direct X-API-Key call to the Group Service
   ▼
Group Service (CGS) ──▶ Group's PDS
```

- In **dev**, Vite serves the SPA (port 5173) and proxies `/api` to the BFF
  (port 3001).
- In **production** (single container), the BFF also serves the built SPA, so one
  process serves both the UI and the API.

## Local development

> **Note:** the demo is **not** a member of the repo's pnpm workspace, so install
> with `--ignore-workspace` — otherwise pnpm treats the repo root as the workspace
> and skips the demo's dependencies.

```bash
cd demo
pnpm install --ignore-workspace
cp .env.example .env   # then fill in the values below
pnpm dev               # runs the BFF (tsx watch) and Vite together
```

Open the Vite URL it prints (default http://localhost:5173).

### Environment (`.env`)

| Variable             | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `GROUP_SERVICE_URL`  | CGS base URL, e.g. `https://dev.groups.certified.app`.                         |
| `GROUP_SERVICE_DID`  | CGS DID (the JWT `aud`), e.g. `did:web:dev.groups.certified.app`.              |
| `EPDS_URL`           | The ePDS users authenticate against, e.g. `https://epds1.test.certified.app`. |
| `SESSION_SECRET`     | Random string for the BFF session cookie (`openssl rand -hex 32`).            |
| `OAUTH_CLIENT_ID`    | URL of the OAuth client metadata — **must be publicly reachable** so the ePDS can fetch it (e.g. `https://<your-domain>/client-metadata.json`). |
| `OAUTH_REDIRECT_URI` | OAuth callback, e.g. `https://<your-domain>/api/oauth/callback`.               |

Because OAuth requires the ePDS to fetch your `client-metadata.json`, the demo
needs a **publicly reachable domain** to fully log in — pure `localhost` won't
complete the OAuth round-trip.

## Production build

```bash
pnpm build    # vite build → dist/ (client) + tsc → dist-server/ (BFF)
pnpm start    # node dist-server/index.js  (set NODE_ENV=production)
```

With `NODE_ENV=production`, the BFF serves the built SPA from `dist/` (override
with `CLIENT_DIST`) and listens on `PORT` (falling back to `BFF_PORT`, then 3001).

## Deploying to Railway

The demo deploys as its **own** Railway service (separate from the group service,
which uses the repo-root `railway.toml`):

1. Create a new Railway service in the project, pointing at this repo.
2. Build settings — the demo builds with the **repo root** as context (the
   service's Root Directory is the repo root, and `demo/Dockerfile` copies only
   `demo/*`):
   - **Root Directory:** the repo root (default / unset).
   - **Config-as-code path:** [`railway-demo.toml`](../railway-demo.toml) — set
     this explicitly, since the repo root already has `railway.toml` for the
     group service. It builds `demo/Dockerfile`.
3. Set the service variables listed under [Environment](#environment-env) — with
   `OAUTH_CLIENT_ID` / `OAUTH_REDIRECT_URI` pointing at the service's Railway
   domain.

Railway injects `PORT`; the BFF serves both the API and the SPA. The healthcheck
path is `/api/health`.
