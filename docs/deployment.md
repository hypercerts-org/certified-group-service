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

`ENCRYPTION_KEY` encrypts the credentials CGS stores for each group: the app password it uses to log in to the group's PDS and, for groups created through `group.register`, the recovery key. Rotate it if the key may have been exposed, or as routine hygiene.

You cannot just swap the value. The stored credentials are encrypted under the old key, so with a new `ENCRYPTION_KEY` every decrypt fails, and CGS refuses to start if that leaves no stored app password readable (see [If something goes wrong](#if-something-goes-wrong)). Instead, CGS re-encrypts the credentials itself at startup, so nobody has to read the current key. That matters on platforms like Railway, where a sealed variable cannot be viewed.

When `ENCRYPTION_KEY_NEXT` is set, CGS re-encrypts every stored credential from `ENCRYPTION_KEY` to `ENCRYPTION_KEY_NEXT` before the server starts listening, in a single database transaction: every row changes or none does. From then on it uses `ENCRYPTION_KEY_NEXT` for everything, including groups registered or imported afterwards. The procedure ends by moving the new key into `ENCRYPTION_KEY`. Without `ENCRYPTION_KEY_NEXT`, startup instead refuses to start when there are stored app passwords and `ENCRYPTION_KEY` can decrypt none of them. That catches a cut-over that left the wrong value in `ENCRYPTION_KEY`.

### Procedure

1. **Save the current key and back up.** First copy the current `ENCRYPTION_KEY` into your secret manager. A sealed variable cannot be viewed in the dashboard, but the running service has it in its environment: open a shell in the container (`railway ssh` on Railway) and run `printenv ENCRYPTION_KEY`. Without this copy the backup below cannot be decrypted, so it is no use for recovery. Then back up the data volume with your platform's volume backup. If you need a file copy instead, make it with SQLite's backup API from a shell inside the running container: the runtime image has no `sqlite3` CLI, and copying `global.sqlite`, `-wal` and `-shm` one by one while the service runs can give an inconsistent copy. Only `global.sqlite` changes during rotation.

   ```bash
   cd /app && node -e "require('better-sqlite3')('/app/data/global.sqlite').backup('/app/data/global.sqlite.bak').then(() => console.log('backup done'))"
   ```

   `/app` is the image's working directory (`WORKDIR /app` in the `Dockerfile`), and the `cd` makes `require('better-sqlite3')` resolve from its `node_modules` wherever your shell starts. Adjust the data paths if your `DATA_DIR` is not `/app/data`, and copy the file off the volume if you can.

2. **Generate a new key** and keep a copy in your secret manager. You need the same value again in step 6, and a sealed variable cannot be read back.

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Add `ENCRYPTION_KEY_NEXT=<new key>`** (sealed, on Railway). Leave `ENCRYPTION_KEY` untouched. Redeploy.
4. **Check the boot log** for the warning `Encryption key rotation complete`. `rekeyed` should equal the number of stored credentials: one app password per group, plus a recovery key for each group that has one (groups created through `group.register`; imported groups have none). The line is logged at `warn`, so it is hidden if `LOG_LEVEL` is `error` or `fatal`. Then smoke-test a group write, for example `putRecord`.
5. **Confirm nothing was missed.** Redeploy once more with `ENCRYPTION_KEY_NEXT` still set. The boot log must show `rekeyed: 0`, which proves every stored credential is on the new key. A value above 0 means the previous deploy kept running briefly and wrote credentials under the old key (see [Overlapping deploys](#if-something-goes-wrong)); this boot has just moved them over, so redeploy again until it shows 0. One extra redeploy is normally enough, because the deploy it can overlap with already uses the new key. Do not skip this step: the boot check after step 6 only requires one readable app password, so it would not catch a stray old-key row.
6. **Cut over.** Set `ENCRYPTION_KEY` to the new key, remove `ENCRYPTION_KEY_NEXT`, and redeploy. This boot does no re-keying, but it refuses to start if `ENCRYPTION_KEY` can decrypt none of the stored app passwords (see [If something goes wrong](#if-something-goes-wrong)). Smoke-test a group write again: a fresh process decrypts with `ENCRYPTION_KEY` alone, so this confirms the value you pasted is the right one. This step is cleanup: nothing breaks if it waits while `ENCRYPTION_KEY_NEXT` stays set, but finish it before the next rotation.
7. **Take a new backup and check it.** Back up the volume again as in step 1. Check that the copy opens and has the same number of rows in `groups` as the live database, for example `cd /app && node -e "console.log(require('better-sqlite3')('/app/data/global.sqlite.bak', { readonly: true }).prepare('SELECT count(*) AS n FROM groups').get())"` against the live file and the copy. Until this backup is confirmed, the old backups and the old key are your only way back.
8. **Delete the old backups** taken before step 3, including `global.sqlite.bak` if you made one. They are encrypted under the retired key.

`ENCRYPTION_KEY_NEXT` can stay set across restarts and redeploys until step 6. Values already under the new key are skipped, so a repeat boot logs `rekeyed: 0` and changes nothing. Setting it equal to `ENCRYPTION_KEY` (letter case aside) is refused at startup with `ENCRYPTION_KEY_NEXT must differ from ENCRYPTION_KEY. If rotation is complete, remove ENCRYPTION_KEY_NEXT.`

### If something goes wrong

- **A `RekeyError` or a config error stops the rotation boot.** If any stored value cannot be decrypted with either key, startup aborts with a `RekeyError` naming the group's DID and the column, for example `Cannot decrypt groups.encrypted_app_password for did:plc:abc with ENCRYPTION_KEY or ENCRYPTION_KEY_NEXT. No rows were changed. Check that ENCRYPTION_KEY is the key the data was written with.` An invalid `ENCRYPTION_KEY_NEXT` is refused before the database is opened. In both cases the stored credentials are untouched, so fix the variables and redeploy, or remove `ENCRYPTION_KEY_NEXT` to go back to where you were. Where the platform keeps the previous deploy running until the new one is healthy, that deploy keeps serving in the meantime.
- **The deploy fails after the re-key.** The re-key commits before the rest of startup (per-group database migrations, the member-index backfill, binding the port). If the log shows `Encryption key rotation complete`, the re-key is committed even if the deploy failed afterwards: keep `ENCRYPTION_KEY_NEXT` set, fix the cause, and redeploy. Do not remove it, because `ENCRYPTION_KEY` alone can no longer read the stored credentials. If you cannot see the log line (see the `LOG_LEVEL` note in step 4), keep `ENCRYPTION_KEY_NEXT` set as well: a repeat boot with it set changes nothing.
- **Do not roll back after step 3.** Once the re-key has committed (the `Encryption key rotation complete` log line), the stored credentials are encrypted under the new key and the old key cannot read them. A build that predates `ENCRYPTION_KEY_NEXT` reads only `ENCRYPTION_KEY`, so it works again only once `ENCRYPTION_KEY` holds the new key (step 6).
- **Overlapping deploys.** If your platform keeps the previous deploy running for a moment after the new one starts, that deploy only knows the old key. A fresh login on it fails, and a group registered or imported through it is written under the old key. Rotate during low traffic. Step 5 handles this: the extra boot with `ENCRYPTION_KEY_NEXT` still set re-keys anything the previous deploy wrote under the old key, which shows up as `rekeyed` above 0. Whether the overlap exists depends on the platform, so check how yours redeploys a service that has a volume.
- **Startup fails with `ENCRYPTION_KEY cannot decrypt any of the stored group app passwords`.** The full message is `ENCRYPTION_KEY cannot decrypt any of the stored group app passwords (0 of 12 readable), so no group could log in to its PDS. If you just finished a key rotation, ENCRYPTION_KEY must hold the value that was ENCRYPTION_KEY_NEXT. Otherwise check that it is the key the data was written with. See docs/deployment.md#rotating-encryption_key.` It means `ENCRYPTION_KEY` does not hold the key the stored credentials are encrypted with. After a rotation, step 6 left the old (or a mistyped) value in it. Without this check the service would start and pass its healthcheck, then fail each group's first PDS write with a decryption error. To recover, put `ENCRYPTION_KEY_NEXT=<new key>` back, leave `ENCRYPTION_KEY` as it is, and redeploy. That boot re-keys anything written under the wrong key in the meantime (`rekeyed` above 0). Then redo step 6, and do not overwrite `ENCRYPTION_KEY` again before that boot has run. If the key the stored credentials are encrypted with no longer exists anywhere, they cannot be recovered. Restore the step 1 backup if you still have the old `ENCRYPTION_KEY` it was encrypted under. Otherwise each group has to be reset and onboarded again, and there is no supported procedure for that yet. Do not just delete rows from the `groups` table: the per-group databases and `member_index` rows stay behind, and re-importing then fails or leaves the group with two owners. The check passes when at least one app password is readable, so keep the smoke test in step 6.

### What rotation does not cover

Rotation protects stored credentials against someone who obtained only the old key, or only a copy of the data. It does not help if an attacker held both: they could already decrypt the app passwords and recovery keys, which stay valid after the key changes. In that case the credentials themselves must also be replaced: revoke and re-issue each group's app password, and replace any stored recovery key in the DID's PLC rotation keys. That is not part of this procedure.
