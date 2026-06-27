# Deployment

## General requirements

CGS requires:

- **Node.js 22+** runtime
- **Persistent storage** for SQLite databases (the `DATA_DIR` directory)
- **Three required environment variables**: `ENCRYPTION_KEY`, `SERVICE_URL`, and `GROUP_PDS_URL`

The service exposes a health check at `GET /health` (also reachable as `GET /xrpc/_health`) that returns `{"status":"ok","service":"group-service","version":"..."}`.

## Docker

The included Dockerfile creates a minimal production image using a multi-stage build with `node:22-slim`.

```bash
docker build -t group-service .
docker run -p 3000:3000 \
  -e SERVICE_URL=https://group-service.example.com \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -e GROUP_PDS_URL=https://pds.example.com \
  -v $(pwd)/data:/app/data \
  group-service
```

The container expects a volume mounted at `/app/data` for database persistence.

## Admin endpoints

CGS exposes operator-only admin endpoints under `app.certified.group.admin.*`
(currently `setOwner`, which reassigns a group's owner). They are gated by
**HTTP Basic auth** — username `admin`, password the `CGS_ADMIN_PASSWORD`
environment variable — and are **disabled entirely when `CGS_ADMIN_PASSWORD` is
unset** (every request returns `401`; there is no insecure default). When set,
the password must be at least 16 non-whitespace characters.

This is the same admin-password mechanism the upstream AT Protocol **reference
PDS** uses for its `com.atproto.admin.*` endpoints, deliberately adopted here.
The trust model follows from that precedent: a PDS operator can already control
much of the data and accounts they host, and is expected to use that power only
in ways their users have agreed to and that benefit them. CGS hosts groups on
the same basis, so the operator holds an admin credential that can act on hosted
groups and is expected to use it only with the consent of, and for the benefit
of, those groups. This power is accountable: every admin action — including an
ownership change via `setOwner` — is recorded in the target group's audit log,
attributed to actor `admin`, so its use is transparent and reviewable by the
group.

Treat `CGS_ADMIN_PASSWORD` like any other high-value secret: set it only if you need
the admin endpoints, store it in your platform's secret store (not in the
repo), and rotate it if exposed. See the [Admin operations](api-reference.md#admin-operations)
section of the API reference for the endpoint contracts.

Helper scripts:

- `scripts/set-cgs-admin-password.sh` — generate a strong `CGS_ADMIN_PASSWORD`
  with `openssl` and set it on a Railway environment.
- `scripts/set-owner.sh` — reassign a group's owner by calling
  `app.certified.group.admin.setOwner` (HTTP Basic auth, reads
  `CGS_ADMIN_PASSWORD` from the environment). Run with `--dry-run` first.

## Deploying to Railway

CGS is pre-configured for [Railway](https://railway.app/) via `railway.toml`.

### Step-by-step

1. **Create a new project** from your GitHub repository in the Railway dashboard

2. **Configure environment variables** in the service settings:

   | Variable         | Value                                                                                    |
   | ---------------- | ---------------------------------------------------------------------------------------- |
   | `SERVICE_URL`    | Full public URL (e.g. `https://your-app.up.railway.app`)                                 |
   | `ENCRYPTION_KEY` | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `GROUP_PDS_URL`  | URL of the PDS where group accounts are created (e.g. `https://pds.example.com`)         |
   | `DATA_DIR`       | `/app/data`                                                                              |

   `PORT` is injected automatically by Railway — do not set it manually. The three required variables above must be provided; the remaining optional variables have sensible defaults (see the [environment variables table](../README.md#environment-variables)).

   > **Note:** `SERVICE_URL` is written into each group's DID document as the service endpoint. It must be a full public URL (scheme + host) so that atproto-proxy resolution works — a bare hostname will not resolve correctly.

3. **Add a persistent volume** — this is critical:
   - Right-click your service (or click **+**) → **Add Volume**
   - Mount path: `/app/data`
   - Without a volume, all SQLite databases are lost on every redeploy

4. **Deploy** — Railway auto-detects the Dockerfile, builds, and deploys

5. **Verify** — hit `https://your-app.up.railway.app/health` and confirm `status` is `"ok"` and a `version` is reported

### Railway configuration

The `railway.toml` is already set up:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 60
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
drainingSeconds = 30

[environments.staging.deploy]
restartPolicyMaxRetries = 3

[environments.production.deploy]
restartPolicyMaxRetries = 10
```

### SQLite on Railway

CGS uses SQLite with WAL (Write-Ahead Logging) mode, which works well with a single replica:

- **Single replica is required** — SQLite is a single-writer database. Do not scale to multiple replicas, as concurrent writes from different processes will cause database lock errors.
- **Volume is required** — without a persistent volume, databases are lost on redeploy since Railway containers are ephemeral.
- **Backup strategy** — consider periodic copies of the `/app/data` directory. SQLite databases in WAL mode can be safely copied while the service is running using `sqlite3 <db> ".backup <dest>"`.

## Other platforms

CGS runs anywhere you can run a Docker container with persistent storage. Key considerations:

- Mount a persistent volume at whatever path you set for `DATA_DIR`
- Expose port `3000` (or whatever `PORT` is set to)
- Set `SERVICE_URL` to the full public URL of the service (e.g. `https://group-service.example.com`)
- Use the `/health` endpoint for health checks
- Run a single replica only (SQLite constraint)
