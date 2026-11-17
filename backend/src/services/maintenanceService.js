// Background housekeeping used by the scheduler and by Admin → System health.
//   * close idle listening sessions so preferences are folded in
//   * hourly trend snapshot (feeds the "trending" signal of the recommender)
// Each trend run is a pipeline_jobs row keyed by the hour, so several API
// instances or restarts never produce duplicate snapshots.
const { query, one, call } = require('../config/db');
const runner = require('./jobRunner');
const settings = require('./settingsService');

async function runTrendSnapshot({ requestedBy = null, key = null } = {}) {
  const hourKey = (await one("SELECT DATE_FORMAT(NOW(), '%Y-%m-%dT%H') AS h")).h;
  const { job } = await runner.createJob({ type: 'TREND_SNAPSHOT', key: key || `trend:${hourKey}`, requestedBy });
  if (job.status !== 'DISCOVERED') return { jobId: job.job_id, status: job.status, reused: true };
  const { job: done } = await runner.run(job.job_id, async (j) => {
    await runner.setStatus(j.job_id, 'PROCESSING');
    const sets = await call('sp_generate_trend_snapshot', [j.job_id]);
    const rows = sets[0] || [];
    await runner.log(j.job_id, 'INFO', 'TREND_ANALYSIS', `Snapshot written: ${rows.map((r) => `${r.window_code}/${r.entity_type}=${r.entities}`).join(', ')}`);
    return { entities: rows.reduce((s, r) => s + Number(r.entities), 0) };
  });
  return { jobId: done.job_id, status: done.status };
}

async function closeIdleSessions(idleMinutes) {
  const idle = await query("SELECT session_id FROM listening_sessions WHERE status = 'OPEN' AND last_activity_at < NOW() - INTERVAL ? MINUTE", [idleMinutes]);
  for (const s of idle) await call('sp_close_listening_session', [s.session_id]);
  return idle.length;
}

/**
 * Retention (Admin → Settings decides the periods): search history, mood mixes nobody saved,
 * read notifications older than 90 days, and used or expired account tokens.
 */
async function applyRetention() {
  const cfg = await settings.all();
  const searches = await query('DELETE FROM search_history WHERE searched_at < NOW() - INTERVAL ? DAY LIMIT 50000', [cfg.search_history_days]);
  const mixes = await query(`DELETE FROM recommendation_batches
                              WHERE created_at < NOW() - INTERVAL ? DAY
                                AND NOT EXISTS (SELECT 1 FROM playlists p WHERE p.source_batch_id = recommendation_batches.batch_id)
                                AND NOT EXISTS (SELECT 1 FROM listening_history lh WHERE lh.batch_id = recommendation_batches.batch_id)
                              LIMIT 20000`, [cfg.unsaved_mix_days]);
  const notes = await query('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < NOW() - INTERVAL 90 DAY LIMIT 50000');
  const tokens = await query('DELETE FROM account_tokens WHERE (used_at IS NOT NULL OR expires_at < NOW()) AND created_at < NOW() - INTERVAL 7 DAY LIMIT 50000');
  return { searches: searches.affectedRows, mixes: mixes.affectedRows, notifications: notes.affectedRows, tokens: tokens.affectedRows };
}

module.exports = { runTrendSnapshot, closeIdleSessions, applyRetention };
