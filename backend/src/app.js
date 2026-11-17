// Express application (exported separately from server.js so tests can import it).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { corsOrigins, nodeEnv, trustProxy, validateEnvironment } = require('./config/env');
const routes = require('./routes');
const readiness = require('./services/readinessService');
const { sameOriginOnly } = require('./middleware/auth');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { originAllowed } = require('./utils/origins');
const log = require('./utils/log');

const app = express();
app.disable('x-powered-by');
// Trust exactly the proxies LOOP runs behind (Vercel rewrite + Railway edge = 2 on Railway), so req.ip is
// the visitor's address and rate limits are per visitor. See docs/DEPLOYMENT.md.
app.set('trust proxy', trustProxy);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'same-origin' },
  strictTransportSecurity: nodeEnv === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
}));

// One structured line per API request: method, route, status, duration and a request id that is
// also returned to the client (X-Request-Id) and attached to server-side error logs. No bodies,
// cookies, tokens or query strings are logged.
app.use('/api', (req, res, next) => {
  const started = process.hrtime.bigint();
  req.id = crypto.randomBytes(6).toString('hex');
  res.set('X-Request-Id', req.id);
  res.on('finish', () => {
    if (req.path === '/health') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log.info('request', { id: req.id, method: req.method, path: req.route ? req.baseUrl + req.route.path : req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) });
  });
  next();
});

// Cross-origin browser access only for the listed origins (exact, or one-label wildcard patterns for
// approved preview deployments). Same-origin requests through the Vercel rewrite need no CORS.
app.use('/api', cors({
  origin: (origin, cb) => cb(null, !!origin && originAllowed(origin, corsOrigins)),
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Auth-Mode', 'X-Upload-Token'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 600,
}));
app.use('/api', sameOriginOnly(corsOrigins));
app.use(express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => { if (!req.path.startsWith('/artwork/')) res.set('Cache-Control', 'no-store'); next(); });

// Liveness: the process is up. Does not touch the database.
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Do not let a missing cloud database leave the frontend spinning indefinitely.
app.use('/api', (req, res, next) => {
  try {
    validateEnvironment();
    return next();
  } catch {
    return res.status(503).json({
      error: { code: 'DATABASE_NOT_CONFIGURED', message: 'LOOP is deployed, but its MySQL database connection is not configured yet.' },
    });
  }
});

// Readiness: database reachable, schema at the expected version, storage, scanner and proxy setup.
app.get('/api/ready', async (req, res, next) => {
  try {
    const r = await readiness.check(req);
    res.status(r.status === 'ready' ? 200 : 503).json(r);
  } catch (err) { next(err); }
});

app.use('/api', routes);
app.use('/api', notFound);

// Serve the built frontend (npm run build) from the same origin when the API host also serves the site.
const dist = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: nodeEnv === 'production' ? '1h' : 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);
module.exports = app;
