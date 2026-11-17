// Readiness: can this instance serve real traffic? Database, schema version, media storage,
// malware scanner and the proxy/cookie configuration. Never includes secrets, hostnames or
// connection strings.
const { one, query } = require('../config/db');
const { files } = require('../../scripts/migrate');
const { localMedia } = require('../providers');
const env = require('../config/env');

function expectedVersion() {
  const all = files();
  return all.length ? all[all.length - 1].version : '0000';
}

const PRIVATE = /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;

async function check(req = null) {
  const expected = expectedVersion();
  const out = {
    status: 'ready', database: 'up', schema: { expected, current: null }, mediaStorage: null,
    runtime: { nodeEnv: env.nodeEnv, secureCookies: env.session.secureCookies, trustProxy: env.trustProxy, onRailway: env.onRailway,
      allowedOrigins: env.corsOrigins.length, emailConfigured: !!(env.email.resendApiKey && env.email.from) },
  };
  if (req) {
    // Behind Vercel + Railway the visitor's address must be public; a private one means TRUST_PROXY is wrong.
    out.runtime.clientIpLooksPublic = !PRIVATE.test(String(req.ip || ''));
  }
  try {
    const r = await one('SELECT MAX(version) AS v FROM schema_migrations');
    out.schema.current = r ? r.v : null;
    const s = await one("SELECT COUNT(*) AS n FROM songs WHERE status = 'ACTIVE'");
    out.catalogue = { activeSongs: s.n };
    const playable = await query("SELECT COUNT(*) AS n FROM v_song_playback p JOIN songs s ON s.song_id = p.song_id AND s.status = 'ACTIVE'");
    out.catalogue.playableSongs = playable[0].n;
  } catch (err) {
    out.status = 'not_ready';
    out.database = err.errno === 1146 || err.errno === 1142 ? 'up' : 'down';
    if (out.database === 'up') out.schema.problem = 'migration history unreadable — run npm run db:migrate';
    return out;
  }
  if (out.schema.current !== expected) {
    out.status = 'not_ready';
    out.schema.problem = out.schema.current < expected
      ? 'database schema is behind the code — run npm run db:migrate'
      : 'database schema is newer than this code — deploy the matching release';
  }
  out.mediaStorage = localMedia.check();
  return out;
}

module.exports = { check, expectedVersion };
