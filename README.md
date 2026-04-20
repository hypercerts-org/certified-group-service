# Certified Group Service (CGS)

An [AT Protocol](https://atproto.com/) service that adds **role-based access control** to group-governed repositories on a Personal Data Server (PDS). CGS lets multiple users collaboratively manage a single atproto repository with fine-grained permissions, full audit logging, and secure credential management.

## How it works

CGS acts as an authenticated proxy between clients and a group's PDS:

1. **Client sends a request** with a signed JWT (`Authorization: Bearer <token>`)
2. **AuthVerifier** validates the JWT signature against the caller's DID document, checks the audience against the group registry, and enforces nonce-based replay prevention
3. **RbacChecker** looks up the caller's role in the group and verifies they have permission for the requested operation
4. **PDS proxy** forwards the request to the group's backing PDS using securely stored credentials
5. **AuditLogger** records every action (permitted or denied) for compliance and debugging

### Role hierarchy

| Role | Level | Capabilities |
|------|-------|-------------|
| **member** | 0 | Create records, edit/delete own records, upload blobs, list members |
| **admin** | 1 | All member permissions + edit/delete any member's records, edit group profile, manage members, query audit log |
| **owner** | 2 | All admin permissions + set roles (promote/demote members) |

### Storage

- **Global SQLite database** — group registry and nonce cache
- **Per-group SQLite databases** — members, record authorship tracking, audit log
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
# Edit .env — at minimum set ENCRYPTION_KEY and SERVICE_URL

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

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server listen port |
| `SERVICE_URL` | **Yes** | — | Public URL of this service (e.g. `https://group-service.example.com`). Written into group DID documents for atproto-proxy resolution. |
| `DATA_DIR` | No | `./data` | Directory for SQLite databases |
| `ENCRYPTION_KEY` | **Yes** | — | 32-byte hex key for AES-256-GCM encryption of stored PDS credentials. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLC_URL` | No | `https://plc.directory` | PLC directory URL for DID resolution |
| `DID_CACHE_TTL_MS` | No | `600000` | DID document cache TTL in milliseconds (10 min) |
| `MAX_BLOB_SIZE` | No | `5242880` | Maximum blob upload size in bytes (5 MB) |
| `LOG_LEVEL` | No | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

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
