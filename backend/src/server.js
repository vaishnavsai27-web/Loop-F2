// Persistent Node entrypoint for local development and non-serverless hosts.
// The persistent API process (Railway, a VPS or local development): HTTP listener plus background jobs.
const { port, jobs, validateEnvironment } = require('./config/env');

try {
  validateEnvironment();
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'config', error: err.message }));
  process.exit(1);
}

const app = require('./app');
const { pool } = require('./config/db');
const scheduler = require('./services/scheduler');
const { localMedia } = require('./providers');
const accounts = require('./services/accountService');
const log = require('./utils/log');

const server = app.listen(port, () => {
  const storage = localMedia.check();
  log.info('started', { port, mediaStorage: storage.state, persistence: storage.persistence });
  if (storage.state === 'ephemeral') log.warn('media_not_persistent', { detail: storage.detail });
  // Accounts using a password published in the repository must change it before doing anything else.
  accounts.enforcePublishedPasswordGuard().catch((err) => log.error('published_password_guard', { error: err.message }));
  if (jobs.enabled) scheduler.start();
  else log.info('jobs_disabled', {});
});

async function shutdown(signal) {
  log.info('shutdown', { signal });
  scheduler.stop();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
