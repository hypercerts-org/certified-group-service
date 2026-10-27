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
- **Backup strategy** — consider periodic copies of the `/app/data` directory. SQLite databases in WAL mode can be safely copied while the service is running using SQLite's backup API; step 1 of [Rotating `ENCRYPTION_KEY`](#rotating-encryption_key) shows how (the runtime image has no `sqlite3` CLI).

## Other platforms

CGS runs anywhere you can run a Docker container with persistent storage. Key considerations:

- Mount a persistent volume at whatever path you set for `DATA_DIR`
- Expose port `3000` (or whatever `PORT` is set to)
- Set `SERVICE_URL` to the full public URL of the service (e.g. `https://group-service.example.com`)
- Use the `/health` endpoint for health checks
- Run a single replica only (SQLite constraint)

## Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` encrypts each group's stored PDS app password and, for groups created through `group.register`, its recovery key. You cannot just swap the value: the stored credentials would no longer decrypt. Instead, set `ENCRYPTION_KEY_NEXT` and CGS re-encrypts everything at startup, in one transaction, before it serves requests. Nobody needs to read the current key, so this works with sealed Railway variables.

### Procedure

1. **Save the current key and back up.** Copy the current key into your secret manager (on Railway: `railway ssh`, then `printenv ENCRYPTION_KEY`). The backup is not encrypted by this key, but the credentials inside it are, so the backup is useless for recovery without it. Treat the backup as sensitive. Use your platform's volume backup, or SQLite's backup API from inside the container (the image has no `sqlite3` CLI, and copying the `-wal`/`-shm` files by hand can give an inconsistent copy):

   ```bash
   cd /app && node -e "require('better-sqlite3')('/app/data/global.sqlite').backup('/app/data/global.sqlite.bak').then(() => console.log('backup done'))"
   ```

   Adjust paths if `DATA_DIR` is not `/app/data`. Only `global.sqlite` changes during rotation.

2. **Generate a new key** and save it in your secret manager; you need it again in step 6.

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Set `ENCRYPTION_KEY_NEXT=<new key>`** (sealed). Leave `ENCRYPTION_KEY` alone. Redeploy.
4. **Check the boot log** for `Encryption key rotation complete` (logged at `warn`, hidden if `LOG_LEVEL` is `error` or `fatal`). `rekeyed` should match the number of stored credentials. Smoke-test a group write, e.g. `putRecord`.
5. **Confirm nothing was missed.** Redeploy again with `ENCRYPTION_KEY_NEXT` still set. The log must show `rekeyed: 0`. If it is above 0, the previous deploy wrote credentials under the old key while overlapping (see [Overlapping deploys](#if-something-goes-wrong)); redeploy until it shows 0. Do not skip this: the check in step 6 only needs one readable credential, so it would miss a stray one.
6. **Cut over.** Set `ENCRYPTION_KEY` to the new key, remove `ENCRYPTION_KEY_NEXT`, redeploy, and smoke-test again. Startup refuses to run if `ENCRYPTION_KEY` opens none of the stored app passwords. This can wait, but finish it before the next rotation.
7. **Take a new backup and check it** opens and has the same `groups` row count as the live DB:

   ```bash
   cd /app && node -e "console.log(require('better-sqlite3')('/app/data/global.sqlite.bak', { readonly: true }).prepare('SELECT count(*) AS n FROM groups').get())"
   ```

8. **Delete backups taken before step 3**, including `global.sqlite.bak`. They can only be restored together with the retired key, so delete them once the step 7 backup is confirmed. Until then they are sensitive: everything except the credentials is plaintext.

`ENCRYPTION_KEY_NEXT` can stay set across redeploys until step 6; repeat boots log `rekeyed: 0` and change nothing. Setting it equal to `ENCRYPTION_KEY` fails startup with `ENCRYPTION_KEY_NEXT must differ from ENCRYPTION_KEY.`

### If something goes wrong

- **`RekeyError: Cannot decrypt groups.encrypted_app_password for did:… with ENCRYPTION_KEY or ENCRYPTION_KEY_NEXT`.** A stored value opens with neither key. No rows were changed. Fix the variables and redeploy, or remove `ENCRYPTION_KEY_NEXT` to go back.
- **Deploy failed after `Encryption key rotation complete` was logged.** The re-key is already committed. Keep `ENCRYPTION_KEY_NEXT` set, fix the cause, and redeploy. If you can't see the log line, keep it set anyway; a repeat boot is harmless.
- **Do not roll back after step 3.** Once the re-key commits, the old key and older builds cannot read the credentials.
- **Overlapping deploys.** If the platform keeps the old deploy running briefly, it only knows the old key and may write new credentials under it. Rotate during low traffic; step 5 catches these.
- **`ENCRYPTION_KEY cannot decrypt any of the stored group app passwords`.** `ENCRYPTION_KEY` holds the old or a mistyped value, usually after step 6. Put `ENCRYPTION_KEY_NEXT=<new key>` back, leave `ENCRYPTION_KEY` as is, redeploy, then redo step 6. If that boot fails with `RekeyError`, some credentials are still under the real old key: set `ENCRYPTION_KEY` to the old key saved in step 1, keep `ENCRYPTION_KEY_NEXT` set, and redeploy.
- **The key is lost.** If no copy of the key the credentials are encrypted with exists, they cannot be recovered. Restore the step 1 backup if you still have its key; otherwise groups must be re-onboarded (no supported procedure yet). Do not just delete rows from `groups`: per-group data and `member_index` rows stay behind and re-importing breaks.

### What rotation does not cover

Rotation does not help if an attacker had both the old key and a copy of the data: they could already decrypt the credentials. In that case also revoke and re-issue each group's app password and replace any stored recovery key in the DID's PLC rotation keys. That is not part of this procedure.
