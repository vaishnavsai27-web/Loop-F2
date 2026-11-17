// Platform settings an Admin can change in the console (no redeploy, no SQL).
// Secrets and infrastructure stay in environment variables; only runtime-safe values live here.
const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const log = require('../utils/log');
const audit = require('./auditService');

const DEFS = {
  registration_open: { type: 'bool', default: true, label: 'New accounts can register' },
  maintenance_message: { type: 'text', default: '', max: 300, label: 'Notice shown to everyone (empty = none)' },
  artist_applications_open: { type: 'bool', default: true, label: 'Users can apply for Artist access' },
  upload_max_mb: { type: 'int', default: 50, min: 1, max: 50, label: 'Largest audio upload (MB)' },
  upload_quota_mb: { type: 'int', default: 500, min: 10, max: 10000, label: 'Upload allowance per artist per 30 days (MB)' },
  open_uploads_per_artist: { type: 'int', default: 5, min: 1, max: 50, label: 'Uploads an artist can have in progress at once' },
  application_cooldown_days: { type: 'int', default: 7, min: 0, max: 365, label: 'Days before a rejected applicant can apply again' },
  search_history_days: { type: 'int', default: 90, min: 1, max: 3650, label: 'Keep search history for (days)' },
  unsaved_mix_days: { type: 'int', default: 60, min: 1, max: 3650, label: 'Keep unsaved mood mixes for (days)' },
};

let cache = null;
let cacheAt = 0;

function coerce(key, raw) {
  const d = DEFS[key];
  if (d.type === 'bool') return raw === true || raw === 'true' || raw === '1' || raw === 1;
  if (d.type === 'int') return Number(raw);
  return String(raw ?? '');
}

function validate(key, value) {
  const d = DEFS[key];
  if (!d) throw ApiError.badRequest(`Unknown setting ${key}.`);
  if (d.type === 'bool' && typeof value !== 'boolean') throw ApiError.badRequest(`${d.label}: choose on or off.`);
  if (d.type === 'int' && (!Number.isInteger(value) || value < d.min || value > d.max)) throw ApiError.badRequest(`${d.label}: enter a whole number from ${d.min} to ${d.max}.`);
  if (d.type === 'text' && (typeof value !== 'string' || value.length > d.max)) throw ApiError.badRequest(`${d.label}: at most ${d.max} characters.`);
  return d.type === 'bool' ? (value ? 'true' : 'false') : String(value);
}

async function all() {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  // Before migration 0018 the table does not exist yet: run on defaults, but say so in the logs.
  const rows = await query('SELECT setting_key, setting_value FROM platform_settings').catch((err) => {
    if (err.errno !== 1146) throw err;
    log.warn('platform_settings table missing; using default settings until migrations run');
    return [];
  });
  const stored = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  cache = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, k in stored ? coerce(k, stored[k]) : d.default]));
  cacheAt = Date.now();
  return cache;
}

const get = async (key) => (await all())[key];

async function describe() {
  const values = await all();
  return Object.entries(DEFS).map(([key, d]) => ({ key, label: d.label, type: d.type, min: d.min, max: d.max, value: values[key], default: d.default }));
}

async function update(actor, changes) {
  const entries = Object.entries(changes || {});
  if (!entries.length) throw ApiError.badRequest('Nothing to change.');
  const before = await all();
  await withTransaction(async (tx) => {
    for (const [key, value] of entries) {
      const stored = validate(key, value);
      await tx.query(`INSERT INTO platform_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`, [key, stored, actor.id]);
    }
    await audit.record(tx, actor, 'SETTINGS_CHANGED', 'platform_settings', 'platform',
      Object.fromEntries(entries.map(([k]) => [k, before[k]])), Object.fromEntries(entries));
  }, { actorId: actor.id });
  cache = null;
  return describe();
}

module.exports = { all, get, describe, update, validate, DEFS };
