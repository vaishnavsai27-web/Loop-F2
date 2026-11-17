// Load configuration without terminating the process at import time.
// Persistent Node entrypoints call validateEnvironment() before listening;
// Vercel Functions validate on each API request and can still serve liveness.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// SESSION_SECRET keys CSRF tokens and IP hashes. Keep compatibility with old .env files.
if (!process.env.SESSION_SECRET && process.env.JWT_SECRET) {
  process.env.SESSION_SECRET = process.env.JWT_SECRET;
}

const num = (v, d, min, max, name) => {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return n;
};

const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true');
const isProd = process.env.NODE_ENV === 'production';
const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);

/**
 * Express "trust proxy". LOOP's production path is browser → Vercel (rewrite) → Railway edge → Express,
 * i.e. two proxies in front of the app, so on Railway the default is 2. A number counts hops; anything
 * else is passed through (e.g. "loopback, uniquelocal"). 0 trusts no proxy (local development).
 */
function parseTrustProxy(v) {
  if (v === undefined || v === '') return onRailway ? 2 : 0;
  if (/^\d+$/.test(String(v).trim())) return num(v, 0, 0, 5, 'TRUST_PROXY');
  if (v === 'true' || v === 'false') throw new Error('TRUST_PROXY must be a hop count (e.g. 2) or proxy names, not true/false');
  return String(v);
}

/** "https://a.com, https://loop-*-team.vercel.app" → exact origins and single-label wildcard patterns. */
function parseOrigins(v) {
  const list = String(v || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  for (const o of list) {
    if (o === '*' || !/^https?:\/\/[^/]+$/.test(o)) throw new Error(`CORS_ORIGIN entry "${o}" must be a full origin like https://loop.example.com`);
    if ((o.match(/\*/g) || []).length > 1) throw new Error(`CORS_ORIGIN entry "${o}" may contain at most one *`);
  }
  return list;
}

function validateEnvironment() {
  const required = ['DB_HOST', 'DB_NAME', 'DB_APP_USER', 'DB_APP_PASSWORD', 'SESSION_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  if (isProd && process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  }
  return true;
}

const timezone = process.env.DB_TIMEZONE || '+00:00';
if (!/^[+-](0[0-9]|1[0-4]):[0-5][0-9]$/.test(timezone)) {
  throw new Error('DB_TIMEZONE must look like +00:00 or +05:30');
}

module.exports = {
  parseTrustProxy,
  parseOrigins,
  nodeEnv: process.env.NODE_ENV || 'development',
  isServerless,
  port: Number(process.env.PORT || 4000),
  validateEnvironment,
  db: {
    host: process.env.DB_HOST,
    port: num(process.env.DB_PORT, 3306, 1, 65535, 'DB_PORT'),
    database: process.env.DB_NAME,
    appUser: process.env.DB_APP_USER,
    appPassword: process.env.DB_APP_PASSWORD || '',
    appHost: process.env.DB_APP_HOST || 'localhost',
    ownerUser: process.env.DB_OWNER_USER,
    ownerPassword: process.env.DB_OWNER_PASSWORD || '',
    timezone,
    // Enable TLS when the selected managed MySQL host requires it. A provider CA
    // can be supplied as DB_SSL_CA; do not disable certificate verification.
    ssl: bool(process.env.DB_SSL, false),
    sslCa: process.env.DB_SSL_CA || null,
    connectTimeoutMs: num(process.env.DB_CONNECT_TIMEOUT_MS, 10000, 1000, 60000, 'DB_CONNECT_TIMEOUT_MS'),
    poolMax: num(process.env.DB_POOL_MAX, isServerless ? 3 : 12, 1, 50, 'DB_POOL_MAX'),
  },
  session: {
    secret: process.env.SESSION_SECRET,
    ttlHours: num(process.env.SESSION_TTL_HOURS, 12, 1, 720, 'SESSION_TTL_HOURS'),
    secureCookies: bool(process.env.COOKIE_SECURE, isProd),
  },
  onRailway,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // The address people use (https://loop.example.com). Used for links in emails and reset pages.
  publicOrigin: (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') || null,
  // Optional: the API's own origin (e.g. the Railway domain). Large uploads go straight there so they
  // do not pass through the 120-second Vercel proxy; they are authorised by a signed upload token.
  uploadOrigin: (process.env.UPLOAD_ORIGIN || '').replace(/\/+$/, '') || null,
  adminSession: {
    ttlHours: num(process.env.ADMIN_SESSION_HOURS, 4, 1, 72, 'ADMIN_SESSION_HOURS'),
    idleMinutes: num(process.env.ADMIN_IDLE_MINUTES, 60, 10, 1440, 'ADMIN_IDLE_MINUTES'),
    reauthMinutes: num(process.env.ADMIN_REAUTH_MINUTES, 10, 1, 120, 'ADMIN_REAUTH_MINUTES'),
  },
  email: {
    // Transactional email through Resend's HTTPS API (https://resend.com). Without a key, LOOP shows
    // messages in the in-app inbox and Admins issue reset links from the console instead.
    resendApiKey: process.env.RESEND_API_KEY || null,
    from: process.env.EMAIL_FROM || null,
  },
  seedGuard: bool(process.env.SEED_ACCOUNT_GUARD, isProd),
  rateLimits: {
    authFailuresPer15Min: num(process.env.RATE_LIMIT_AUTH_FAILURES, 20, 1, 10000, 'RATE_LIMIT_AUTH_FAILURES'),
    registrationsPerHour: num(process.env.RATE_LIMIT_REGISTRATIONS_PER_HOUR, 5, 1, 1000, 'RATE_LIMIT_REGISTRATIONS_PER_HOUR'),
    writesPerMinute: num(process.env.RATE_LIMIT_WRITES_PER_MIN, 240, 1, 100000, 'RATE_LIMIT_WRITES_PER_MIN'),
  },
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  jobs: {
    enabled: bool(process.env.JOBS_ENABLED, true),
    sessionIdleMinutes: num(process.env.SESSION_IDLE_MINUTES, 30, 1, 1440, 'SESSION_IDLE_MINUTES'),
  },
};
