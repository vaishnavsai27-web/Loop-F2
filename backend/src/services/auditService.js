// The audit ledger (audit_logs). The application account can only INSERT and SELECT it.
// Every entry keeps a snapshot of who acted (actor_label), so deleting an account later
// does not erase who did what.
const { query } = require('../config/db');

/** actor: req.user-like object ({ id, username }) or null for the system. runner: tx or null. */
async function record(runner, actor, action, entityType, entityId, oldValues = null, newValues = null, ipHash = null) {
  const run = runner ? runner.query : query;
  await run(
    `INSERT INTO audit_logs (actor_user_id, actor_label, action, entity_type, entity_id, old_values, new_values, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [actor ? actor.id : null, actor ? String(actor.username || '').slice(0, 60) || null : null, String(action).slice(0, 40),
      String(entityType).slice(0, 30), String(entityId).slice(0, 40),
      oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null, ipHash]);
}

function filters({ actor, action, entityType, entityId, from, to }) {
  const where = ['1 = 1']; const params = [];
  if (actor) { where.push('(a.actor_label LIKE ? OR a.actor_user_id = ?)'); params.push(`%${actor}%`, Number(actor) || 0); }
  if (action) { where.push('a.action = ?'); params.push(action); }
  if (entityType) { where.push('a.entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('a.entity_id = ?'); params.push(String(entityId)); }
  if (from) { where.push('a.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('a.created_at < ? + INTERVAL 1 DAY'); params.push(`${to} 00:00:00`); }
  return { sql: where.join(' AND '), params };
}

async function list(q = {}) {
  const page = q.page || 1; const pageSize = q.pageSize || 50;
  const f = filters(q);
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM audit_logs a WHERE ${f.sql}`, f.params);
  const rows = await query(
    `SELECT a.audit_id AS id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.old_values AS oldValues,
            a.new_values AS newValues, a.created_at AS createdAt, a.actor_user_id AS actorId,
            COALESCE(a.actor_label, up.display_name) AS actor
       FROM audit_logs a LEFT JOIN user_profiles up ON up.user_id = a.actor_user_id
      WHERE ${f.sql} ORDER BY a.audit_id DESC LIMIT ? OFFSET ?`, [...f.params, pageSize, (page - 1) * pageSize]);
  const actions = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  return { total, page, pageSize, entries: rows.map(parse), actions: actions.map((r) => r.action) };
}

const parse = (r) => ({ ...r,
  oldValues: typeof r.oldValues === 'string' ? JSON.parse(r.oldValues) : r.oldValues,
  newValues: typeof r.newValues === 'string' ? JSON.parse(r.newValues) : r.newValues });

/** Entries about one entity (detail pages). */
async function forEntity(entityType, entityId, limit = 50) {
  const rows = await query(
    `SELECT a.audit_id AS id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.old_values AS oldValues,
            a.new_values AS newValues, a.created_at AS createdAt, COALESCE(a.actor_label, 'system') AS actor
       FROM audit_logs a WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.audit_id DESC LIMIT ?`, [entityType, String(entityId), limit]);
  return rows.map(parse);
}

/** One CSV cell: quoted when needed, and spreadsheet formulas (=, +, -, @) neutralised. */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]|^[=+\-@\t]/.test(s) ? `"${s.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""')}"` : s;
}

/** CSV export of the filtered ledger (at most 10,000 rows). */
async function csv(q = {}) {
  const f = filters(q);
  const rows = await query(
    `SELECT a.audit_id, a.created_at, COALESCE(a.actor_label, 'system') AS actor, a.action, a.entity_type, a.entity_id,
            a.old_values, a.new_values
       FROM audit_logs a WHERE ${f.sql} ORDER BY a.audit_id DESC LIMIT 10000`, f.params);
  const head = 'id,time,actor,action,entity_type,entity_id,before,after';
  return [head, ...rows.map((r) => [r.audit_id, r.created_at, r.actor, r.action, r.entity_type, r.entity_id, r.old_values, r.new_values].map(csvCell).join(','))].join('\n');
}

module.exports = { record, list, forEntity, csv, csvCell };
