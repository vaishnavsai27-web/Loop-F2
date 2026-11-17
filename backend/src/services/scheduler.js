// In-process scheduler for persistent hosts (Railway). Every task is idempotent, so restarts or
// several API instances are safe. Each task has its own "running" flag, so a slow task never makes
// another one skip its turn.
//   every minute  close idle listening sessions; upload pipeline (scan due uploads, expire stale intents)
//   every hour    trend snapshot; purge ended sign-ins; re-check media files; published-password guard
//   every day     retention (search history, unsaved mood mixes, read notifications, used tokens)
const { jobs } = require('../config/env');
const maintenance = require('./maintenanceService');
const sessions = require('./sessionService');
const media = require('./mediaService');
const uploads = require('./uploadService');
const accounts = require('./accountService');
const { localMedia } = require('../providers');
const log = require('../utils/log');

const timers = [];
const running = new Set();

async function guarded(name, fn) {
  if (running.has(name)) return;
  running.add(name);
  try { await fn(); } catch (err) { log.error('scheduler', { task: name, error: err.sqlMessage || err.message }); } finally { running.delete(name); }
}

async function minutely() {
  const closed = await maintenance.closeIdleSessions(jobs.sessionIdleMinutes);
  if (closed) log.info('scheduler', { task: 'idle_sessions', closed });
}

async function pipeline() {
  const r = await uploads.runPipeline({ limit: 5 });
  if (r.expired || r.scanned) log.info('scheduler', { task: 'upload_pipeline', ...r });
}

async function hourly() {
  const purged = await sessions.purgeEnded(30);
  if (purged) log.info('scheduler', { task: 'session_purge', purged });
  if (localMedia.check().state === 'ready') {
    const m = await media.checkLocal();
    if (m.unavailable) log.warn('scheduler', { task: 'media_check', missing: m.unavailable });
  }
  await accounts.enforcePublishedPasswordGuard();
  await maintenance.runTrendSnapshot({});
}

async function daily() {
  const r = await maintenance.applyRetention();
  log.info('scheduler', { task: 'retention', ...r });
}

function start() {
  timers.push(setInterval(() => guarded('minutely', minutely), 60 * 1000));
  timers.push(setInterval(() => guarded('pipeline', pipeline), 60 * 1000));
  timers.push(setInterval(() => guarded('hourly', hourly), 60 * 60 * 1000));
  timers.push(setInterval(() => guarded('daily', daily), 24 * 60 * 60 * 1000));
  setTimeout(() => {
    guarded('minutely', minutely);
    guarded('pipeline', pipeline);
    guarded('hourly', hourly);
    guarded('daily', daily);
  }, 3000).unref();
  timers.forEach((t) => t.unref());
  log.info('scheduler_started', { tasks: ['minutely', 'pipeline', 'hourly', 'daily'] });
}

function stop() { timers.splice(0).forEach(clearInterval); }

module.exports = { start, stop, minutely, pipeline, hourly, daily };
