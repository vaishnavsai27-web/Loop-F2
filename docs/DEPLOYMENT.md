# Deployment and operations

LOOP runs as two pieces:

| Piece | Host | What it does |
|---|---|---|
| Frontend | Vercel (GitHub-connected) | Builds `frontend/` and serves `frontend/dist`. Rewrites `/api/*` to the API. Sends the CSP and security headers. |
| API | Railway (persistent Node 26 service) | `npm start`: Express API, background jobs (upload scanning, session clean-up, retention), audio and artwork on a Railway volume. |
| Database | Managed MySQL 8 (Railway MySQL or another provider) | Reached only by the API, with the least-privilege `DB_APP_USER`. |

There is no Vercel Function: the API exists once, on Railway. `npm run deploy:check` verifies this contract.

## Vercel

`vercel.json`:

| Setting | Value |
|---|---|
| Install / build / output | `npm ci` / `npm run build` / `frontend/dist` |
| `/api/:path*` | rewritten to `https://loop-final-production.up.railway.app/api/:path*` |
| Other paths | `/index.html` (single-page app) |
| Headers | Content-Security-Policy, HSTS, `nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy; long cache for `/assets/*`; `no-cache` for `/sw.js` |

If the Railway URL changes, change it in **both** the `/api` rewrite and the CSP `connect-src` (direct uploads go
there). Vercel needs no secrets and no database variables.

Vercel stops a proxied (rewritten) request after 120 seconds. Audio uploads therefore go straight to the API host
when `UPLOAD_ORIGIN` is set on Railway (see below); the browser sends the file with a per-upload token.

## Railway

Service settings: start command `npm start`, Node 26 (from `engines`), health check path `/api/ready`.

**Volume (required for audio).** Attach a volume to the service, for example at `/data`. Railway sets
`RAILWAY_VOLUME_MOUNT_PATH`; LOOP then keeps media under it (`/data/media`) unless `LOCAL_MEDIA_DIR` points
elsewhere inside the volume. Without a volume the disk is wiped on every deploy, so LOOP refuses uploads and says
so in Admin → System health (set `ALLOW_EPHEMERAL_MEDIA=true` only for throw-away testing).

**Scanner.** Uploads are reviewed only after ClamAV and ffprobe pass. Add a ClamAV service in the same Railway
project (the `clamav/clamav` image, port 3310) and set `CLAMAV_HOST` to its private hostname. `ffprobe` (part of
ffmpeg) must be installed in the API's build image and on its PATH, or `FFPROBE_PATH` must point to it; check your
Railway builder's documentation for adding a system package.
Until both are configured, uploads wait in quarantine and Admin → System health shows the scanner as not ready.

### Environment variables (Railway)

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_APP_USER`, `DB_APP_PASSWORD` | yes | the app account (not the owner) |
| `DB_SSL`, `DB_SSL_CA` | provider-dependent | `true` for any database reached over the internet |
| `DB_TIMEZONE` | yes | e.g. `+05:30` |
| `SESSION_SECRET` | yes | 32+ random characters |
| `COOKIE_SECURE` | default `true` in production | keep `true` |
| `CORS_ORIGIN` | yes | every browser origin, comma separated: `https://<your-domain>,https://<project>.vercel.app`. Preview pattern allowed: `https://loop-final-*-<team>.vercel.app`. A bare `*` is rejected. |
| `PUBLIC_ORIGIN` | yes | the address people use, e.g. `https://<your-domain>` (used in emailed links) |
| `UPLOAD_ORIGIN` | recommended | the API's own public URL, e.g. `https://loop-final-production.up.railway.app` |
| `TRUST_PROXY` | default `2` on Railway | hops in front of Express (Vercel → Railway edge). Check Admin → System health: the address it shows must be your public IP. |
| `LOCAL_MEDIA_DIR` | optional | defaults to `<volume>/media` |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `FFPROBE_PATH` | for uploads | see above |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | enables password-reset, verification and moderation emails. Without them Admins create reset links in People. |
| `ADMIN_SESSION_HOURS`, `ADMIN_IDLE_MINUTES`, `ADMIN_REAUTH_MINUTES` | optional | defaults 4 h, 60 min, 10 min |
| `SEED_ACCOUNT_GUARD` | default `true` in production | forces accounts with published seed passwords to choose a new one. Never turn off in production. |
| `RATE_LIMIT_AUTH_FAILURES`, `RATE_LIMIT_WRITES_PER_MIN`, `RATE_LIMIT_REGISTRATIONS_PER_HOUR` | optional | defaults 20 / 240 / 5 |
| `JOBS_ENABLED` | default `true` | background jobs; keep on for exactly one API instance |

Never set the database owner credentials on Railway's web service. Run migrations from a trusted machine or a
one-off Railway shell with the owner account.

## Releasing a version

1. CI passes on the pull request (`.github/workflows/ci.yml`: secret scan, lint, unit tests, build, release audits,
   then API/SQL/browser tests on MySQL 8.4 and 8.0).
2. **Back up** (`npm run db:backup`, or run the *Database backup* workflow by hand).
3. Apply migrations with the owner account: `npm run db:migrate`. Migrations only move forward and never drop data.
   `/api/ready` reports `not_ready` while the schema and the code disagree.
4. Merge to `main`: Vercel and Railway deploy. Then:

```bash
LOOP_PRODUCTION_URL=https://<your-domain> npm run deploy:smoke        # homepage, /api/health, /api/ready
BASE_URL=https://<your-domain> E2E_ADMIN_LOGIN=… E2E_ADMIN_PASSWORD=… npm run test:e2e   # against a staging copy
```

A successful push is not a successful deployment: check both build logs and `/api/ready`.

## Backups and recovery

**Schedule.** `.github/workflows/backup.yml` runs daily at 02:05 IST (and on demand). It dumps the database with
`mysqldump --single-transaction`, verifies the gzip and checksum, uploads it to S3-compatible storage, then restores
that same file into a disposable MySQL container and checks it — every backup is a tested backup. A run fails
loudly (GitHub emails the owner) if backups are not configured.

Configure in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DB_BACKUP_HOST`, `DB_BACKUP_PORT`, `DB_BACKUP_DATABASE` | production database (public/proxy address) |
| `DB_BACKUP_USER`, `DB_BACKUP_PASSWORD` | a read-only account with `SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS` |
| `DB_BACKUP_S3_URI` | `s3://bucket/loop` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | write-only key for that bucket |

Variables (optional): `DB_BACKUP_SSL=true`, `DB_BACKUP_S3_ENDPOINT` (Cloudflare R2, Backblaze B2, …),
`DB_BACKUP_S3_REGION`.

**Retention.** Set a lifecycle rule on the bucket: keep daily dumps 35 days and the first dump of each month for
12 months. Turn on bucket encryption and versioning; the backup key must not be able to delete.

**Media.** Audio and artwork live on the Railway volume. Use Railway's volume backups (service → Volume → Backups)
on a daily schedule. The database records which files exist; Admin → Uploads & audio → Media library → *Check every
recording now* marks anything missing after a restore.

**Restore (disaster recovery).**

1. Download the newest dump and its `.sha256` from the bucket.
2. Prove it first: `DB_BACKUP_FILE=loop-db-….sql.gz npm run db:restore:drill` against a scratch MySQL.
3. Create the new production database and restore into it with the owner account
   (`gunzip -c loop-db-….sql.gz | mysql --defaults-extra-file=owner.cnf <db>`). Re-create the app account with the
   grants in `database/06_security.sql` (replace `__DB__`, `__APP_USER__`, `__APP_HOST__`), then run
   `npm run db:migrate` (it applies only migrations newer than the dump). Never use `db:setup` here: it drops the
   database.
4. Point Railway's `DB_*` at it, redeploy, and confirm `/api/ready` shows `status: ready` and the expected schema.
5. Restore the media volume from its backup, then run *Check every recording now*.

Target: lose at most one day of data (RPO 24 h); be back within two hours (RTO 2 h).

## Monitoring

* `.github/workflows/uptime.yml` checks the site and `/api/ready` every 30 minutes once the repository variable
  `LOOP_PUBLIC_URL` is set; a failure emails the owner.
* Railway collects the API's logs: one JSON line per request (`method`, `route`, `status`, `ms`, `requestId`) and
  for every error. A 5xx response carries the same `requestId`, so a user's report can be matched to the log line.
* Admin → System health: database, schema, storage, scanner, data-integrity checks, failed jobs, proxy check,
  accounts with published passwords.

## Local or self-hosted

```bash
npm ci && npm run build
npm run db:migrate
NODE_ENV=production npm start      # serves frontend/dist and /api on PORT
```
