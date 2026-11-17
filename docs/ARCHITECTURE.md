# Architecture

```
Browser (React 18, Vite build, installable PWA)
  └─ fetch /api/* (same origin, httpOnly session cookie + CSRF header)
Vercel (static frontend, CSP and security headers)
  └─ rewrite /api/* → Railway
       (large audio uploads go straight to the Railway host with a per-upload token)
Express API on Railway (backend/src/app.js; request id + JSON logs; scheduler; media volume)
  helmet CSP → CORS allow-list → origin check → JSON body → routes
  routes/index.js: authentication → permission → validation → controller
  controllers/index.js → services/*.js → MySQL (mysql2 pool, least-privilege account)
MySQL 8.4
  tables, views, stored procedures (recommendation scoring, preference learning), triggers (audit, counters)
```

## Request rules

* Every protected route passes `requireAuth`, which resolves the session token, then re-reads the user, role and
  permissions from the database. Admin routes also pass `requirePermission(...)`; Artist tools pass
  `artist.studio` / `artist.upload`. The frontend's route guards are a convenience; the API is the authority.
* Inputs are validated next to each route (`utils/validate.js`); unknown fields are dropped.
* Errors always have the shape `{ "error": { "code", "message", "details?" } }`. MySQL errors are translated, never
  leaked.

## API surface

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/login`, `/logout`, `/logout-all`, `/reauth`, `/password-reset/request`, `/password-reset/confirm`, `/verify-email`; `GET /auth/session`, `/auth/me` |
| Reference | `GET /moods`, `/contexts`, `/genres`, `/languages` |
| Catalogue | `GET /songs`, `/songs/:id`, `/artists/:id`, `/albums/:id`, `/picks`, `/search`, `/search/suggest`, `/platform`, `/artwork/:file` |
| Recommendations | `POST /recommendations/mood`, `POST /recommendations/parse`, `GET /recommendations/for-you`, `/similar`, `/history`, `/batches/:id`, `GET /users/:id/recommendations` |
| Feedback | `PUT/DELETE /songs/:id/rating`, `PUT /songs/:id/like`, `GET /likes`, `PUT/DELETE /songs/:id/dismiss`, `GET /me/dismissals` |
| Library | `GET/POST /playlists`, `POST /playlists/from-batch`, `GET/PATCH/DELETE /playlists/:id`, `POST /playlists/:id/songs`, `PUT /playlists/:id/order`, `PUT /playlists/:id/share`, `DELETE /playlists/:id/songs/:songId`, `GET /shared/playlists/:token` |
| Playback | `POST /playback/start`, `POST /playback/:playId/finish`, `GET /history`, `GET /media/:id` |
| Account | `GET/DELETE /me/sessions…`, `POST /me/password`, `POST /me/verify-email`, `DELETE /me`, `GET/PUT /me/preferences`, `PATCH /me/settings`, `GET /me/notifications`, `GET /me/privacy`, `GET /me/export`, `DELETE /me/history/*`, `GET /me/reports` |
| Reports | `POST /reports` (song, artist, album or account) |
| Artist | `GET /artist/me`, `/artist/stats`, `POST /artist/applications`, `…/:id/withdraw`, `PATCH /artist/profiles/:id`, `POST /artist/uploads`, `GET /artist/uploads/:id`, `PUT /uploads/:id/content`, `PUT /artist/uploads/:id/artwork`, `POST /artist/uploads/:id/withdraw` |
| Admin | `/admin/overview`, `/badges`, `/users…`, `/artist-applications…`, `/name-changes…`, `/artists…`, `/songs…`, `/albums…`, `/uploads…`, `/media…`, `/reports…`, `/taxonomy`, `/moods…`, `/genres…`, `/languages…`, `/contexts…`, `/settings`, `/recommender`, `/picks…`, `/duplicates`, `/audit`, `/audit.csv`, `/health`, `/permissions`, `/security/published-passwords`, `/references` — each behind a permission; sensitive writes also need a recent password check |
| Ops | `GET /health` (liveness), `GET /ready` (database, schema version, media storage) |

`npm run ui:audit` fails if the frontend calls a path that is not in this router.

## Frontend

* `lib/router.jsx` — small history-API router (no dependency). `lib/api.js` — every API call.
  `lib/auth.jsx` — session state; the role always comes from `/auth/session`.
* Three shells (`components/Shell.jsx`): listener (Discover, Search, Library, Settings), Artist studio and Admin
  console. Wrong-role routes render an access-denied page.
* `pages/Discover.jsx` is the core journey: composer → interpretation → ranked, explained results → feedback.
* Design system in `styles/loop.css` (tokens at the top). One bold element — the mood composer and its aura drawn
  from the moods' own colours; everything else is quiet lists, ink type and one action colour.
