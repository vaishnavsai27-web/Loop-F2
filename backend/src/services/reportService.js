// Reports about songs, artists, albums and user accounts, and their moderation.
const { query, one, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const audit = require('./auditService');
const notify = require('./notifyService');
const catalogAdmin = require('./catalogAdminService');
const artists = require('./artistService');
const accounts = require('./accountService');

const TARGETS = {
  SONG: { table: 'songs', key: 'song_id', label: 'title' },
  ARTIST: { table: 'artists', key: 'artist_id', label: 'name' },
  ALBUM: { table: 'albums', key: 'album_id', label: 'title' },
  USER: { table: 'users', key: 'user_id', label: 'username' },
};

async function targetLabel(type, id) {
  const t = TARGETS[type];
  const row = await one(`SELECT ${t.label} AS label FROM ${t.table} WHERE ${t.key} = ?`, [id]);
  return row ? row.label : null;
}

async function create(user, { targetType, targetId, reason, details, evidenceRef = null }) {
  if (!TARGETS[targetType]) throw ApiError.badRequest('You can report a song, artist, album or account.');
  if (targetType === 'USER' && targetId === user.id) throw ApiError.badRequest('You cannot report your own account.');
  const label = await targetLabel(targetType, targetId);
  if (!label) throw ApiError.notFound('What you reported');
  const [{ recent }] = await query('SELECT COUNT(*) AS recent FROM content_reports WHERE reporter_user_id = ? AND created_at >= NOW() - INTERVAL 1 DAY', [user.id]);
  if (recent >= 10) throw new ApiError(429, 'TOO_MANY_REPORTS', 'You have sent 10 reports today. LOOP will review them; try again tomorrow.');
  const open = await one(`SELECT report_id FROM content_reports WHERE reporter_user_id = ? AND target_type = ? AND target_id = ? AND status IN ('OPEN','UNDER_REVIEW')`,
    [user.id, targetType, targetId]);
  if (open) throw ApiError.conflict('ALREADY_REPORTED', 'You already reported this. LOOP will let you know the outcome.');
  return withTransaction(async (tx) => {
    const r = await tx.query(`INSERT INTO content_reports (reporter_user_id, target_type, target_id, reason, details, evidence_ref) VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, targetType, targetId, reason, details, evidenceRef]);
    await audit.record(tx, user, 'REPORT_SUBMITTED', 'report', r.insertId, null, { targetType, targetId, reason });
    await notify.notifyAdmins(tx, { kind: 'ADMIN_REPORT', title: `New report: ${reason.toLowerCase().replace('_', ' ')} — ${label}`, link: `/admin/reports/${r.insertId}` });
    return { id: r.insertId, status: 'OPEN', message: 'Thanks. A LOOP admin will review your report and let you know the outcome.' };
  });
}

async function mine(userId) {
  const rows = await query(`SELECT report_id AS id, target_type AS targetType, target_id AS targetId, reason, status, resolution_note AS outcome,
                                   created_at AS createdAt, resolved_at AS resolvedAt FROM content_reports WHERE reporter_user_id = ? ORDER BY report_id DESC LIMIT 50`, [userId]);
  return Promise.all(rows.map(async (r) => ({ ...r, target: await targetLabel(r.targetType, r.targetId) })));
}

async function list({ status = 'OPEN', targetType = null, reason = null, page = 1, pageSize = 25 }) {
  const where = ["(? = 'ALL' OR r.status = ?)"]; const params = [status, status];
  if (status === 'ACTIVE') { where.splice(0, 1, "r.status IN ('OPEN','UNDER_REVIEW')"); params.splice(0, 2); }
  if (targetType) { where.push('r.target_type = ?'); params.push(targetType); }
  if (reason) { where.push('r.reason = ?'); params.push(reason); }
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM content_reports r WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT r.report_id AS id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.status, r.details, r.created_at AS createdAt,
            r.resolution_action AS resolutionAction, ru.username AS reporter, au.username AS assignedTo,
            (SELECT COUNT(*) FROM content_reports o WHERE o.target_type = r.target_type AND o.target_id = r.target_id) AS reportsOnTarget
       FROM content_reports r LEFT JOIN users ru ON ru.user_id = r.reporter_user_id LEFT JOIN users au ON au.user_id = r.assigned_to
      WHERE ${where.join(' AND ')} ORDER BY r.status IN ('OPEN','UNDER_REVIEW') DESC, r.created_at ${status === 'OPEN' || status === 'ACTIVE' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const withLabels = await Promise.all(rows.map(async (r) => ({ ...r, target: await targetLabel(r.targetType, r.targetId) })));
  return { total, page, pageSize, reports: withLabels };
}

async function detail(reportId) {
  const r = await one(
    `SELECT r.report_id AS id, r.target_type AS targetType, r.target_id AS targetId, r.reason, r.details, r.evidence_ref AS evidenceRef,
            r.status, r.resolution_action AS resolutionAction, r.resolution_note AS resolutionNote, r.created_at AS createdAt,
            r.resolved_at AS resolvedAt, r.reporter_user_id AS reporterId, ru.username AS reporter, au.username AS assignedTo
       FROM content_reports r LEFT JOIN users ru ON ru.user_id = r.reporter_user_id LEFT JOIN users au ON au.user_id = r.assigned_to
      WHERE r.report_id = ?`, [reportId]);
  if (!r) throw ApiError.notFound('Report');
  const [notes, related, history] = await Promise.all([
    query("SELECT note_id AS id, COALESCE(author_label, 'LOOP') AS author, body, created_at AS createdAt FROM content_report_notes WHERE report_id = ? ORDER BY note_id", [reportId]),
    query(`SELECT report_id AS id, reason, status, created_at AS createdAt FROM content_reports
            WHERE target_type = ? AND target_id = ? AND report_id <> ? ORDER BY report_id DESC LIMIT 20`, [r.targetType, r.targetId, reportId]),
    audit.forEntity('report', reportId, 30),
  ]);
  let target = null;
  // A target that has since been deleted shows as "no longer exists"; any other failure is a real error.
  const gone = (err) => { if (err.status === 404) return null; throw err; };
  if (r.targetType === 'SONG') target = await catalogAdmin.songDetail(r.targetId).catch(gone);
  if (r.targetType === 'ARTIST') target = await catalogAdmin.artistDetail(r.targetId).catch(gone);
  if (r.targetType === 'ALBUM') target = await catalogAdmin.albumDetail(r.targetId).catch(gone);
  if (r.targetType === 'USER') target = await accounts.userDetail(r.targetId).catch(gone);
  return { ...r, target, notes, related, history, actions: ACTIONS[r.targetType] };
}

/** Moderation actions available per kind of report target. */
const ACTIONS = {
  SONG: ['NONE', 'HIDE', 'SUSPEND', 'TAKE_DOWN', 'MARK_EXPLICIT'],
  ARTIST: ['NONE', 'SUSPEND_ARTIST'],
  ALBUM: ['NONE', 'UNPUBLISH_ALBUM'],
  USER: ['NONE', 'DEACTIVATE_USER', 'LOCK_USER'],
};

async function addNote(actor, reportId, body) {
  await withTransaction(async (tx) => {
    const r = await tx.one('SELECT status FROM content_reports WHERE report_id = ? FOR UPDATE', [reportId]);
    if (!r) throw ApiError.notFound('Report');
    await tx.query('INSERT INTO content_report_notes (report_id, author_user_id, author_label, body) VALUES (?, ?, ?, ?)', [reportId, actor.id, actor.username, body]);
    if (r.status === 'OPEN') await tx.query("UPDATE content_reports SET status = 'UNDER_REVIEW', assigned_to = ? WHERE report_id = ?", [actor.id, reportId]);
    await audit.record(tx, actor, 'REPORT_NOTE_ADDED', 'report', reportId);
  }, { actorId: actor.id });
  return detail(reportId);
}

async function assign(actor, reportId) {
  const r = await query("UPDATE content_reports SET status = IF(status = 'OPEN', 'UNDER_REVIEW', status), assigned_to = ? WHERE report_id = ? AND status IN ('OPEN','UNDER_REVIEW')", [actor.id, reportId]);
  if (!r.affectedRows) throw ApiError.conflict('REPORT_CLOSED', 'This report is already closed.');
  await audit.record(null, actor, 'REPORT_ASSIGNED', 'report', reportId);
  return detail(reportId);
}

/**
 * Resolve (with an action on the reported content) or dismiss. The moderation action is carried out
 * through the same services the rest of the console uses, so states, notifications and audit match.
 */
async function resolve(actor, reportId, { outcome, action = 'NONE', note }) {
  if (!String(note || '').trim()) throw ApiError.badRequest('Write what you decided; the reporter sees this note.');
  const r = await one('SELECT * FROM content_reports WHERE report_id = ?', [reportId]);
  if (!r) throw ApiError.notFound('Report');
  if (['RESOLVED', 'DISMISSED'].includes(r.status)) throw ApiError.conflict('REPORT_CLOSED', 'This report is already closed.');
  if (outcome === 'DISMISSED' && action !== 'NONE') throw ApiError.badRequest('A dismissed report takes no action.');
  if (!ACTIONS[r.target_type].includes(action)) throw ApiError.badRequest('That action does not apply to this kind of report.');
  const reason = `Report #${reportId}: ${note}`.slice(0, 300);
  switch (action) {
    case 'HIDE': await catalogAdmin.changeState(actor, r.target_id, { action: 'HIDE' }); break;
    case 'SUSPEND': await catalogAdmin.changeState(actor, r.target_id, { action: 'SUSPEND', reason }); break;
    case 'TAKE_DOWN': await catalogAdmin.changeState(actor, r.target_id, { action: 'TAKE_DOWN', reason }); break;
    case 'MARK_EXPLICIT': await catalogAdmin.updateSong(actor, r.target_id, { explicit: true }); break;
    case 'SUSPEND_ARTIST': await artists.suspendArtist(actor, r.target_id, { reason, hideSongs: true }); break;
    case 'UNPUBLISH_ALBUM': await catalogAdmin.updateAlbum(actor, r.target_id, { status: 'UNPUBLISHED' }); break;
    case 'DEACTIVATE_USER': await accounts.setActive(actor, r.target_id, false, reason); break;
    case 'LOCK_USER': await accounts.setLock(actor, r.target_id, true, reason); break;
    default: break;
  }
  await withTransaction(async (tx) => {
    const done = await tx.query(`UPDATE content_reports SET status = ?, resolution_action = ?, resolution_note = ?, assigned_to = ?, resolved_at = NOW()
                                  WHERE report_id = ? AND status IN ('OPEN','UNDER_REVIEW')`, [outcome, action, note, actor.id, reportId]);
    if (!done.affectedRows) throw ApiError.conflict('REPORT_CLOSED', 'Someone closed this report while you were working on it.');
    await tx.query('INSERT INTO content_report_notes (report_id, author_user_id, author_label, body) VALUES (?, ?, ?, ?)',
      [reportId, actor.id, actor.username, `${outcome === 'RESOLVED' ? 'Resolved' : 'Dismissed'}${action !== 'NONE' ? ` — action: ${action.toLowerCase().replace(/_/g, ' ')}` : ''}. ${note}`]);
    await audit.record(tx, actor, outcome === 'RESOLVED' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED', 'report', reportId, { status: r.status }, { action, note });
    if (r.reporter_user_id) {
      await notify.notify(tx, r.reporter_user_id, { kind: 'REPORT_OUTCOME', title: outcome === 'RESOLVED' ? 'LOOP acted on your report' : 'LOOP reviewed your report',
        body: note, link: '/settings/privacy' });
    }
  }, { actorId: actor.id });
  return detail(reportId);
}

module.exports = { create, mine, list, detail, addNote, assign, resolve, ACTIONS };
