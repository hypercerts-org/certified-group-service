# Deployment

## General requirements

CGS requires:

- **Node.js 22+** runtime
- **Persistent storage** for SQLite databases (the `DATA_DIR` directory)
- **Two required environment variables**: `ENCRYPTION_KEY` and `SERVICE_URL`

The service exposes a health check at `GET /health` that returns `{"status":"ok"}`.

## Docker

The included Dockerfile creates a minimal production image using a multi-stage build with `node:22-slim`.

```bash
docker build -t group-service .
docker run -p 3000:3000 \
  -e SERVICE_URL=https://group-service.example.com \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -v $(pwd)/data:/app/data \
  group-service
```

The container expects a volume mounted at `/app/data` for database persistence.

## Deploying to Railway

CGS is pre-configured for [Railway](https://railway.app/) via `railway.toml`.

### Step-by-step

1. **Create a new project** from your GitHub repository in the Railway dashboard

2. **Configure environment variables** in the service settings:

   | Variable | Value |
   |----------|-------|
   | `SERVICE_URL` | Full public URL (e.g. `https://your-app.up.railway.app`) |
   | `ENCRYPTION_KEY` | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `DATA_DIR` | `/app/data` |

   `PORT` is injected automatically by Railway — do not set it manually. All other variables have sensible defaults (see the [environment variables table](../README.md#environment-variables)).

   > **Note:** `SERVICE_URL` is written into each group's DID document as the service endpoint. It must be a full public URL (scheme + host) so that atproto-proxy resolution works — a bare hostname will not resolve correctly.

3. **Add a persistent volume** — this is critical:
   - Right-click your service (or click **+**) → **Add Volume**
   - Mount path: `/app/data`
   - Without a volume, all SQLite databases are lost on every redeploy

4. **Deploy** — Railway auto-detects the Dockerfile, builds, and deploys

5. **Verify** — hit `https://your-app.up.railway.app/health` and confirm `{"status":"ok"}`

### Railway configuration

The `railway.toml` is already set up:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 10
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
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
