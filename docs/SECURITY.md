# Security and roles

## Authentication

* Passwords: bcrypt (cost 10; 12 for provisioned admins), 8–72 characters with a letter and a number. The
  passwords published in the development seed and the most common passwords are refused everywhere a password is
  set.
* Wrong passwords: every fifth consecutive failure locks the account (1, then 5, then 15 minutes). A wrong password
  always gets the same generic answer, so a guesser cannot tell that an account exists or is locked; only the right
  password learns about a lock. Failures are rate-limited per IP and per account and written to the audit log.
* Sessions: random token, stored only as a SHA-256 hash in `auth_sessions`. Browsers get an httpOnly,
  SameSite=Strict, Secure cookie plus a CSRF cookie that must be echoed in `X-CSRF-Token` on every write; writes
  must also come from an allowed origin. Sessions expire (`SESSION_TTL_HOURS`, idle `SESSION_IDLE_MINUTES`) and
  can be revoked one by one or everywhere. A password change or reset signs out every other session.
* Admin sessions are shorter (`ADMIN_SESSION_HOURS`), end after `ADMIN_IDLE_MINUTES` without activity, and
  sensitive actions (deactivate, lock, role change, reset link, anonymise, suspend an artist, delete or merge a song,
  remove audio, change settings or recommender weights) need the password again within `ADMIN_REAUTH_MINUTES`.
* Every request re-reads the user, `is_active`, role and permissions, so deactivation and role changes apply at
  once.
* Password reset: `POST /auth/password-reset/request` always gives the same answer. Tokens are random, stored
  hashed, single-use, valid 30 minutes (24 hours when an Admin creates the link). Email is sent through Resend when
  `RESEND_API_KEY` and `EMAIL_FROM` are set.
* Accounts with a published seed password (`SEED_ACCOUNT_GUARD`, on by default in production) are forced to choose
  a new password at their next sign-in before they can do anything else. Admin → System health → Security lists
  them.

## Roles and permissions

| Permission | User | Artist | Admin |
|---|---|---|---|
| `artist.studio`, `artist.upload` | | ✓ | |
| `catalog.write`, `users.manage`, `artist.review`, `health.view`, `audit.view` | | | ✓ |
| `reports.manage`, `settings.manage`, `media.manage`, `models.tune` | | | ✓ |

The live matrix is in Admin → System health → Permissions.

* Registration ignores any role in the request, records acceptance of the terms, and creates a User.
* Artist: `POST /artist/applications` → an Admin approves it (optionally correcting the artist name or linking an
  existing catalogue artist) → the role becomes Artist. A rejection needs a reason, which the applicant sees.
* An Artist can edit only artist profiles linked to their account and upload only as those artists. A change of
  artist name goes to an Admin for approval, so nobody can rename themselves into someone else. Uploads stay in private quarantine until ClamAV and
  ffprobe pass; review, approval and publication are Admin-only, and a suspended artist cannot upload.
* A published song can only be live when its moderation state is clear and it has a current sound profile; a
  database trigger enforces this no matter which code path writes the row.
* Admin is never granted from the console (`403 ADMIN_PROVISIONING_ONLY`). Provision from the server:

  ```bash
  npm run admin:provision -- --promote some_username
  ADMIN_PASSWORD='a-long-password-1' npm run admin:provision -- --create --username ops_admin --email ops@example.com --name "Ops Admin"
  npm run admin:provision -- --list
  ```

  It uses the database owner account and writes `ADMIN_PROVISIONED` to the audit log. The last active Admin cannot
  be demoted, deactivated or deleted, and every Admin is notified when another Admin's access changes.

## Audit log

`audit_logs` records sign-ins (success and failure), access and role changes, moderation decisions, report
resolutions, deletions, anonymisations and settings changes, with the actor, before/after values and a hashed IP.
The application account can insert but not change or delete audit rows or upload events. Admins filter and export
it (CSV, with spreadsheet formulas neutralised) in Admin → Activity log.

## Privacy

* Users can export their data (Settings → Privacy and data), clear search and listening history, and delete their
  account. When an account has records LOOP must keep (artist uploads, rights declarations, reports), it is
  anonymised instead: name, email, history, likes, playlists and preferences are removed; the records stay under a
  pseudonym.
* Retention runs daily: search history older than `search_history_days`, unsaved mood mixes older than
  `unsaved_mix_days` (Admin → Settings), ended sessions after 30 days, read notifications after 90 days, used or
  expired account tokens after 7 days.
* IP addresses are stored only as salted hashes.

## Headers and transport

* Frontend (Vercel): Content-Security-Policy without inline or eval script, HSTS, `nosniff`, `frame-ancestors 'none'`,
  Referrer-Policy, Permissions-Policy (`vercel.json`).
* API (helmet): CSP, HSTS in production, `nosniff`, no `X-Powered-By`, `Cache-Control: no-store` on API responses.
* CORS: only the origins listed in `CORS_ORIGIN` (exact, or one wildcard label for previews); never `*` with
  credentials.

## Secrets

* Secrets live only in Railway variables and GitHub Actions secrets, never in the repository or the frontend.
* `npm run secret:scan` (also in CI and `deploy:check`) fails on credentials, private keys, `.env` files, database
  dumps and private audio in tracked files.
* Admin → Settings deliberately cannot show or change secrets or infrastructure addresses.

## Before a public deployment

* Do not seed a public database. If an existing database came from the seed, provision a real Admin, then deactivate
  the seeded accounts nobody uses (Admin → System health → Security lists them).
* Set a 32+ character `SESSION_SECRET`, `COOKIE_SECURE=true`, the exact `CORS_ORIGIN`, `PUBLIC_ORIGIN`, and TLS to
  MySQL (`DB_SSL=true`). Confirm `TRUST_PROXY` in Admin → System health.
* The API connects with the least-privilege `DB_APP_USER`; keep owner credentials off the web service.
* Configure backups (docs/DEPLOYMENT.md) and run the backup workflow once by hand before launch.
