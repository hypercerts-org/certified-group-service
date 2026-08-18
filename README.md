# Certified Group Service (CGS)

An [AT Protocol](https://atproto.com/) service that adds **role-based access control** to group-governed repositories on a Personal Data Server (PDS). CGS lets multiple users collaboratively manage a single atproto repository with fine-grained permissions, full audit logging, and secure credential management.

## How it works

CGS acts as a governance and proxy layer for a group's PDS. It supports three authentication modes:

- **Service-auth JWTs** for service-level methods and normal member requests. JWTs are signed by the caller's DID and are single-use.
- **Scoped API keys** for long-lived group-scoped backend access. Keys are sent in `X-API-Key` and are limited by both their scopes and the issuing member's current role.
- **HTTP Basic auth** for operator-only admin methods when `CGS_ADMIN_PASSWORD` is configured.

For a group-scoped JWT request, the supported form uses the service DID as `aud` and an explicit `repo` group selector. The deprecated group-DID `aud` form remains accepted during migration. CGS then:

1. **Authenticates** the request and resolves the target group
2. **Checks RBAC** against the caller's role in that group
3. **Checks API-key scopes**, when the request uses an API key
4. **Proxies repository writes and blob uploads** to the group's PDS using securely stored credentials
5. **Records audited operations and authorization denials** in the per-group audit log

### Role hierarchy

| Role       | Level | Capabilities                                                                                                   |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| **member** | 0     | Create records, edit/delete own records, upload blobs, list members                                            |
| **admin**  | 1     | All member permissions + edit/delete any member's records, edit group profile, manage members, query audit log |
| **owner**  | 2     | All admin permissions + set member/admin roles and initiate ownership transfer                                 |

### Storage

- **Global SQLite database** — group registry, nonce cache, and reverse membership index
- **Per-group SQLite databases** — members, record authorship, audit log, API keys, and pending ownership transfer
- All databases use WAL mode for concurrent read performance

## Prerequisites

- Node.js 22+
- pnpm

## Quick start

```bash
# Clone the repository
git clone https://github.com/your-org/certified-group-service.git
cd certified-group-service

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env — at minimum set ENCRYPTION_KEY, SERVICE_URL, and GROUP_PDS_URL

# Generate an encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Build
pnpm build

# Start (migrations run automatically on startup)
pnpm start
```

For development with hot reload:

```bash
pnpm dev
```

## Environment variables

| Variable                | Required | Default                 | Description                                                                                                                                                                                                |
| ----------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | No       | `3000`                  | HTTP server listen port                                                                                                                                                                                    |
| `SERVICE_URL`           | **Yes**  | —                       | Public URL of this service (e.g. `https://group-service.example.com`). Written into group DID documents for atproto-proxy resolution.                                                                      |
| `SERVICE_DID`           | No       | derived                 | `did:web` DID of this service; derived from `SERVICE_URL` if omitted                                                                                                                                       |
| `DATA_DIR`              | No       | `./data`                | Directory for SQLite databases                                                                                                                                                                             |
| `ENCRYPTION_KEY`        | **Yes**  | —                       | 32-byte hex key for AES-256-GCM encryption of stored PDS credentials. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`                                            |
| `GROUP_PDS_URL`         | **Yes**  | —                       | URL of the PDS where group accounts are created                                                                                                                                                            |
| `GROUP_PDS_INVITE_CODE` | No       | —                       | Invite code for account creation on the group PDS                                                                                                                                                          |
| `CGS_ADMIN_PASSWORD`    | No       | —                       | Enables the operator-only `app.certified.group.admin.*` endpoints (HTTP Basic auth, user `admin`); disabled when unset. Min 16 non-whitespace chars. See [deployment](docs/deployment.md#admin-endpoints). |
| `PLC_URL`               | No       | `https://plc.directory` | PLC directory URL for DID resolution                                                                                                                                                                       |
| `DID_CACHE_TTL_MS`      | No       | `600000`                | DID document cache TTL in milliseconds (10 min)                                                                                                                                                            |
| `MAX_BLOB_SIZE`         | No       | `5242880`               | Maximum blob upload size in bytes (5 MB)                                                                                                                                                                   |
| `LOG_LEVEL`             | No       | `info`                  | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`                                                                                                                                              |

## Running tests

```bash
pnpm test
```

Tests use Vitest with supertest for HTTP integration testing and in-memory SQLite databases.

## Docker

Build and run with Docker:

```bash
docker build -t group-service .
docker run -p 3000:3000 \
  -e SERVICE_URL=https://group-service.example.com \
  -e ENCRYPTION_KEY=<your-64-char-hex-key> \
  -e GROUP_PDS_URL=https://pds.example.com \
  -v $(pwd)/data:/app/data \
  group-service
```

The Dockerfile uses a multi-stage build with `node:22-slim` for a minimal production image.

## Deployment

See [docs/deployment.md](docs/deployment.md) for deployment guides, including Railway.

## Further documentation

- [Integration Guide](docs/integration-guide.md) — step-by-step guide to integrating the group service into your app
- [Architecture](docs/architecture.md) — authentication flow, RBAC model, data model, PDS proxy internals
- [API Reference](docs/api-reference.md) — complete endpoint documentation with examples
- [Deployment](docs/deployment.md) — production deployment guides

## License

MIT
