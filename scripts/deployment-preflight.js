#!/usr/bin/env node
'use strict';
// Static deployment contract checks (npm run deploy:check). No cloud credentials or database needed.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const results = [];
const exists = (rel) => fs.existsSync(path.join(root, rel));
const read = (rel) => (exists(rel) ? fs.readFileSync(path.join(root, rel), 'utf8') : '');
const check = (ok, message) => results.push({ ok: !!ok, message });
const json = (rel) => { try { return JSON.parse(read(rel)); } catch { return null; } };

const pkg = json('package.json') || {};
const vercel = json('vercel.json') || {};
const lock = json('package-lock.json') || {};
const front = json('frontend/package.json') || {};
const back = json('backend/package.json') || {};
const app = read('backend/src/app.js');
const server = read('backend/src/server.js');
const auth = read('backend/src/middleware/auth.js');
const runtime = read('backend/src/providers/runtimeCapabilities.js');
const media = read('backend/src/services/mediaService.js');
const envFile = read('backend/src/config/env.js');
const gitignore = read('.gitignore');
const workflow = read('.github/workflows/ci.yml');

// Runtime
check(pkg.engines?.node === '26.x' && front.engines?.node === '26.x' && back.engines?.node === '26.x'
  && read('.nvmrc').trim() === read('.node-version').trim() && /^26\./.test(read('.nvmrc').trim()),
  'Node.js 26.x is pinned in every package, .nvmrc and .node-version.');

// Lockfile consistency: every declared dependency is in the lock, no removed package lingers
const declared = (p) => ({ ...(p.dependencies || {}), ...(p.devDependencies || {}) });
const lockFront = lock.packages?.frontend || {};
const lockBack = lock.packages?.backend || {};
const same = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
check(same(declared(front), declared(lockFront)) && same(declared(back), declared(lockBack))
  && same(declared(pkg), declared(lock.packages?.[''] || {})),
  'package-lock.json declares exactly the dependencies in each package.json.');
const unwanted = ['react-router-dom', 'lucide-react'].filter((n) => lock.packages?.[`node_modules/${n}`]);
check(unwanted.length === 0, `Removed frontend dependencies are gone from the lockfile${unwanted.length ? ` (${unwanted.join(', ')})` : ''}.`);

// Vercel serves the built frontend; Railway runs the Express API, scheduler and media volume.
check(vercel.installCommand === 'npm ci' && vercel.buildCommand === 'npm run build' && vercel.outputDirectory === 'frontend/dist',
  'vercel.json installs with npm ci, builds the frontend and serves frontend/dist.');
const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
const apiRewrite = rewrites.find((r) => r.source === '/api/:path*');
let apiHost = null;
try { apiHost = apiRewrite && new URL(apiRewrite.destination).origin; } catch { apiHost = null; }
check(apiRewrite && /^https:\/\//.test(apiRewrite.destination) && /\/api\/:path\*$/.test(apiRewrite.destination)
  && rewrites.some((r) => r.source === '/(.*)' && r.destination === '/index.html'),
  `API requests are rewritten to the persistent API host${apiHost ? ` (${apiHost})` : ''}; every other path serves the single-page app.`);
check(!exists('api'), 'No Vercel Function folder: the API runs only on the persistent host (no duplicate serverless copy).');
check(!vercel.crons, 'No Vercel cron jobs (background work runs only on the persistent host).');
const headerRules = Array.isArray(vercel.headers) ? vercel.headers : [];
const pageHeaders = Object.fromEntries((headerRules.find((h) => h.source === '/(.*)')?.headers || []).map((h) => [h.key.toLowerCase(), h.value]));
const csp = pageHeaders['content-security-policy'] || '';
check(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)
  && pageHeaders['x-content-type-options'] === 'nosniff' && /max-age=\d{7,}/.test(pageHeaders['strict-transport-security'] || ''),
  'The frontend sends a strict Content-Security-Policy, HSTS, nosniff and framing protection.');
check(apiHost && new RegExp(`connect-src[^;]*${apiHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(csp),
  'The CSP allows direct uploads to the API host (UPLOAD_ORIGIN) and nothing else cross-origin.');
check(exists('frontend/public/manifest.webmanifest') && exists('frontend/public/sw.js') && /rel="manifest"/.test(read('frontend/index.html'))
  && !/\/api\//.test(read('frontend/public/sw.js').replace(/startsWith\('\/api\/'\)/, '')),
  'LOOP is installable (manifest + service worker) and the service worker never caches the API.');

// Server safety
check(/if\s*\(jobs\.enabled\)\s*scheduler\.start\(\)/.test(server), 'The scheduler starts only in the persistent server process.');
check(/if \(isServerless\) return false/.test(runtime) && /mediaPersistence/.test(runtime) && /check\(\)\.state !== 'ready'\) return;/.test(media),
  'Local media is off on serverless hosts, refuses an unmounted Railway disk, and is never marked missing from there.');
check(/RAILWAY_ENVIRONMENT/.test(envFile) && /parseTrustProxy/.test(envFile) && /parseOrigins/.test(envFile) && !/corsOrigins\s*=\s*\['\*'\]/.test(envFile),
  'Proxy trust defaults to the Vercel → Railway hop count, and CORS origins are an explicit allowlist (no bare *).');
check(/sameSite:\s*'strict'/.test(auth) && /httpOnly/.test(auth) && /csrfMatches/.test(auth) && /requireRecentAuth/.test(auth),
  'Strict httpOnly session cookies, CSRF checks and Admin step-up re-authentication are in place.');
check(/strictTransportSecurity/.test(app) && /x-request-id/i.test(app), 'The API sends HSTS in production and tags every request with an ID for its logs.');
check(/DATABASE_NOT_CONFIGURED/.test(app) && /\/api\/ready/.test(app), 'Missing database configuration returns a clear 503; /api/ready reports readiness.');
check(/^\s*\.env\s*$/m.test(gitignore) && /^\s*\.env\.\*\s*$/m.test(gitignore) && /^\s*!\.env\.example\s*$/m.test(gitignore)
  && /^media\/\*/m.test(gitignore) && /^backups\//m.test(gitignore), '.env files, private media and backups are ignored by git.');
const envLines = read('.env.example').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
check(exists('.env.example') && !envLines.some((l) => /=(?!replace-|change-me|false|true|\d|\.|http|loop|localhost|\+|\s*$).{12,}/.test(l)),
  '.env.example contains placeholders only.');
const secrets = require('./secret-scan').scan();
check(secrets.length === 0, `Secret scan of tracked files is clean${secrets.length ? ` (${secrets.length} finding(s): run npm run secret:scan)` : ''}.`);

// Database
const migrations = fs.readdirSync(path.join(root, 'database/migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
check(migrations.length >= 18 && migrations.at(-1).startsWith('0018_'), `Forward-only migrations present (latest ${migrations.at(-1)}).`);
check(!/(^|[^-])db:reset|DROP DATABASE/i.test(JSON.stringify(pkg.scripts)), 'No destructive database script is exposed at the root.');

// CI
check(/mysql/.test(workflow) && /npm run test:e2e|pytest e2e/.test(workflow) && /npm run test:sql/.test(workflow) && /secret:scan/.test(workflow),
  'CI scans for secrets and runs the API tests and browser tests against a real MySQL service.');
const backupFlow = read('.github/workflows/backup.yml');
check(/schedule:/.test(backupFlow) && /mysql-backup\.js/.test(backupFlow) && /mysql-restore-drill\.js/.test(backupFlow),
  'A scheduled backup runs daily and every backup is restored into a disposable database to prove it works.');

for (const r of results) (r.ok ? console.log : console.error)(`${r.ok ? 'PASS' : 'FAIL'}  ${r.message}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
