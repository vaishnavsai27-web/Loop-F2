# Implementation status — audit remediation release

Branch: `fix/audit-remediation` (from `main` as received). Migration `0018_admin_control_center.sql`.

## What changed

| Area | Result |
|---|---|
| Admin console | Twelve sections with item pages: Overview, People, Artist applications, Artists, Songs, Albums, Uploads & audio (incl. media library), Reports, Moods & genres, Activity log (filters, CSV), Settings (platform, recommender weights, editorial picks), System health (system, security, duplicates, permissions). Routine work needs no SQL, shell or Railway access. |
| Accounts | Terms acceptance, password reset (email via Resend or Admin-made link), email verification, forced change of published seed passwords, progressive lockout that does not reveal itself, Admin step-up re-authentication, shorter idle-limited Admin sessions, data export, history clearing, account deletion or anonymisation. |
| Artist journey | Application with cooldown and withdrawal, Admin approval with name correction or catalogue link, name changes reviewed by Admins, uploads with progress and artwork, scan → review → publish timeline, withdraw and re-submit, listener statistics, suspension. |
| Listening | Play queue (play all, next/previous, reorder, remove), seek, volume, Media Session, browse by mood/genre/language, editorial picks and Daily Mix on Discover, shareable playlists, reports on songs/artists/albums/accounts, notifications. |
| Moderation | Song states (published, needs profile, hidden, suspended, taken down, withdrawn, merged) with server-enforced transitions and a database trigger that blocks publishing anything not clear; report queue with notes, assignment and actions. |
| Platform | Vercel → Railway topology (no duplicate serverless API), CORS allowlist with preview pattern, proxy trust default, Railway volume detection, direct uploads past the Vercel proxy limit, JSON logs with request IDs, HSTS/CSP on both hosts, retention jobs, PWA. |
| Operations | Secret scan (CI and deploy check), daily backup workflow with automatic restore drill, uptime workflow, deployment and recovery runbook. |
| Removed | `api/index.js` (dead Vercel Function), `database/migrations/proposed/`, `frontend/public/data/music-catalog.json`, old `adminService.js`. |

## Verified in the build workspace

No MySQL and no package-registry access here, so Express, mysql2, Vite, Vitest and ESLint could not be installed.

| Check | Result |
|---|---|
| Backend unit tests (`node --test tests/unit`, npm modules stubbed) | 47 passed, 0 failed |
| Frontend unit tests (Vitest specs through a local shim) | 22 passed, 0 failed |
| Lint stand-in (TypeScript checker: undefined names, unused locals/imports, missing exports) | 0 problems in frontend, backend, scripts |
| Every route resolves to a controller | 159 handlers, 0 missing |
| `npm run ui:audit` / `npm run deploy:check` / `npm run secret:scan` | 12/12 · 23/23 · clean |
| Frontend bundle (esbuild in place of Vite) | builds |
| Every Admin, listener and Studio screen rendered in Chromium against fixture API answers, 1440 px and 390 px | 130 renders, 0 page errors, no horizontal overflow |
| Player: play all → playing → seek → queue panel (desktop and phone) | works |

## Not verified here (CI or the owner)

* `npm ci`, ESLint, Vite build and Vitest with the real dependencies on Node 26.
* Migration 0018 against MySQL 8.4 / 8.0, `db:verify`, `test:sql`, the API integration suites and the Playwright suite against a real API and database (all run in CI).
* Vercel and Railway deployments, ClamAV/ffprobe on Railway, Resend email, the backup workflow (needs GitHub secrets).
