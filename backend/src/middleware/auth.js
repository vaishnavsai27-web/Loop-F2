// Authentication (server-side sessions) and authorisation (role -> permissions from the DB).
//
// Two ways to present a session token:
//  * Browser: httpOnly, SameSite=Strict cookie `muse_session`. Because the browser
//    sends it automatically, every state-changing request must also carry the
//    CSRF token (header X-CSRF-Token, value from the readable `muse_csrf` cookie).
//  * API clients and tests: `Authorization: Bearer <token>`. Not sent automatically
//    by browsers, so no CSRF token is needed.
// The user, role and permissions are re-read from the database on every request,
// so revocation, deactivation and demotion take effect immediately.
const sessions = require('../services/sessionService');
const { session: cfg, adminSession, trustProxy } = require('../config/env');
const ApiError = require('../utils/ApiError');
const { originAllowed, requestHosts } = require('../utils/origins');

const SESSION_COOKIE = 'muse_session';
const CSRF_COOKIE = 'muse_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie: ignore */ }
    }
  }
  return out;
}

function cookieOpts(httpOnly, expires) {
  return { httpOnly, secure: cfg.secureCookies, sameSite: 'strict', path: '/', expires };
}

function setSessionCookies(res, s) {
  const expires = new Date(s.expiresAt);
  res.cookie(SESSION_COOKIE, s.token, cookieOpts(true, expires));
  res.cookie(CSRF_COOKIE, s.csrfToken, cookieOpts(false, expires));
}

function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, cookieOpts(true));
  res.clearCookie(CSRF_COOKIE, cookieOpts(false));
}

/** Where the token came from: { token, via: 'cookie' | 'bearer' } or null. */
function readToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) return { token, via: 'bearer' };
  const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return c ? { token: c, via: 'cookie' } : null;
}

// While a password change is required (e.g. a seeded account with a published password),
// only these requests are allowed.
const PASSWORD_CHANGE_ALLOWED = new Set(['GET /api/auth/session', 'GET /api/auth/me', 'POST /api/me/password',
  'POST /api/auth/logout', 'POST /api/auth/logout-all', 'GET /api/me/notifications']);

/**
 * Resolve the presented session onto req.session / req.user.
 * Returns null on success, or the ApiError to send.
 */
async function authenticate(req, res) {
  const t = readToken(req);
  if (!t) return ApiError.unauthorized();
  const s = await sessions.resolve(t.token);
  if (!s || s.invalid) {
    if (t.via === 'cookie') clearSessionCookies(res);
    const msg = s && s.invalid === 'inactive' ? 'This account is no longer active.'
      : s && s.invalid === 'revoked' ? 'You were signed out. Sign in again.'
        : s && s.invalid === 'idle' ? 'You were signed out after a period of inactivity. Sign in again.'
          : 'Your session has expired. Sign in again.';
    return new ApiError(401, 'TOKEN_INVALID', msg);
  }
  if (t.via === 'cookie' && !SAFE.has(req.method) && !sessions.csrfMatches(s.session_id, req.headers['x-csrf-token'])) {
    return new ApiError(403, 'CSRF_FAILED', 'This request could not be verified. Reload the page and try again.');
  }
  const perms = typeof s.permissions === 'string' ? JSON.parse(s.permissions) : s.permissions || [];
  req.session = { id: s.session_id, via: t.via, expiresAt: s.expires_at, authAgeSec: Number(s.auth_age_sec) };
  req.user = {
    id: s.user_id, username: s.username, displayName: s.display_name, role: s.role_code,
    regionCode: s.region_code, contentFilter: s.content_filter, onboarded: !!s.onboarding_completed_at,
    mustChangePassword: !!s.must_change_password,
    permissions: new Set(perms),
  };
  const key = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/+$/, '');
  if (req.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(key)) {
    return new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue.');
  }
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const err = await authenticate(req, res);
    next(err || undefined);
  } catch (err) { next(err); }
}

/** Like requireAuth, but an anonymous request continues without req.user. */
async function optionalAuth(req, res, next) {
  try {
    const err = await authenticate(req, res);
    if (err && err.status !== 401) return next(err);
    next();
  } catch (err) { next(err); }
}

const requirePermission = (...codes) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!codes.every((c) => req.user.permissions.has(c))) return next(ApiError.forbidden('Your role does not allow this action.'));
  next();
};

/**
 * Step-up authentication for privilege and destructive Admin actions: the password must have been
 * entered on this session within ADMIN_REAUTH_MINUTES. The client asks for it and retries.
 */
const requireRecentAuth = (req, res, next) => {
  if (!req.session) return next(ApiError.unauthorized());
  if (req.session.authAgeSec <= adminSession.reauthMinutes * 60) return next();
  return next(new ApiError(401, 'REAUTH_REQUIRED', 'Confirm your password to continue.'));
};

/** /users/:id/... — the user themself, or someone allowed to manage users. */
const requireSelfOr = (perm, param = 'id') => (req, res, next) => {
  const target = Number(req.params[param]);
  if (!Number.isInteger(target) || target < 1) return next(ApiError.badRequest(`${param} must be a positive whole number`));
  if (req.user.id !== target && !req.user.permissions.has(perm)) return next(ApiError.forbidden());
  next();
};

/**
 * Cross-site request guard for state-changing requests that are not yet authenticated
 * (login CSRF) and a second layer for the rest: if the browser sent an Origin header, it
 * must be this site (Host, or X-Forwarded-Host from a trusted proxy such as Vercel's
 * rewrite) or an allowed origin from CORS_ORIGIN.
 */
function sameOriginOnly(allowed) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();   // non-browser clients and same-origin navigations in older browsers
    // Compare hosts, not schemes: behind a TLS-terminating proxy the API may see http while the browser reports https.
    let host = null;
    try { host = new URL(origin).host.toLowerCase(); } catch { /* "null" or malformed origin */ }
    if ((host && requestHosts(req, trustProxy).includes(host)) || originAllowed(origin, allowed)) return next();
    return next(new ApiError(403, 'ORIGIN_REJECTED', 'Requests from other sites are not accepted.'));
  };
}

module.exports = {
  requireAuth, optionalAuth, requirePermission, requireRecentAuth, requireSelfOr, sameOriginOnly,
  setSessionCookies, clearSessionCookies, parseCookies, readToken, SESSION_COOKIE, CSRF_COOKIE,
};
