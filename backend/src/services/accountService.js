// Account recovery, email verification, the published-password guard, Admin user management,
// anonymisation and the listener's own data controls.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { query, one, withTransaction } = require('../config/db');
const { publicOrigin, seedGuard } = require('../config/env');
const sessions = require('./sessionService');
const audit = require('./auditService');
const notify = require('./notifyService');
const ApiError = require('../utils/ApiError');
const { isWeakPassword } = require('../utils/passwordPolicy');
const log = require('../utils/log');

const RESET_MINUTES = 30;
const ADMIN_RESET_HOURS = 24;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const link = (p) => `${publicOrigin || ''}${p}`;

// ---------------------------------------------------------------- tokens
async function issueToken(runner, userId, purpose, minutes, createdBy = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const run = runner ? runner.query : query;
  await run(`UPDATE account_tokens SET used_at = NOW() WHERE user_id = ? AND purpose = ? AND used_at IS NULL`, [userId, purpose]);
  await run(`INSERT INTO account_tokens (user_id, purpose, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
    [userId, purpose, sha256(token), createdBy, minutes]);
  return token;
}

async function consumeToken(tx, token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = await tx.one(
    `SELECT token_id, user_id, expires_at > NOW() AS live, used_at FROM account_tokens
      WHERE token_hash = ? AND purpose = ? FOR UPDATE`, [sha256(token), purpose]);
  if (!row || row.used_at || !row.live) return null;
  await tx.query('UPDATE account_tokens SET used_at = NOW() WHERE token_id = ?', [row.token_id]);
  return row.user_id;
}

// ---------------------------------------------------------------- password reset
/** Always answers the same way, so it never reveals whether an email is registered. */
async function requestReset(emailOrUsername) {
  const id = String(emailOrUsername || '').trim().toLowerCase();
  const u = await one('SELECT user_id, email, is_active FROM users WHERE (email = ? OR username = ?) AND anonymised_at IS NULL', [id, id]);
  if (u && u.is_active && notify.emailEnabled()) {
    const token = await issueToken(null, u.user_id, 'PASSWORD_RESET', RESET_MINUTES);
    await notify.sendEmail(u.email, 'Reset your LOOP password',
      `Someone asked to reset the password for your LOOP account. If it was you, open this link within ${RESET_MINUTES} minutes:\n\n${link(`/reset-password?token=${token}`)}\n\nIf it wasn't you, ignore this email; your password stays the same.`);
    await audit.record(null, { id: u.user_id, username: null }, 'PASSWORD_RESET_REQUESTED', 'user', u.user_id);
  }
  return { ok: true, emailEnabled: notify.emailEnabled(),
    message: notify.emailEnabled()
      ? 'If that account exists, we have emailed a reset link. It works for 30 minutes.'
      : 'Password reset by email is not set up on this LOOP yet. Ask a LOOP admin for a reset link.' };
}

async function resetPassword(token, newPassword) {
  if (isWeakPassword(newPassword)) throw ApiError.badRequest('That password is too common or publicly known. Choose another.');
  const hash = await bcrypt.hash(newPassword, 10);
  return withTransaction(async (tx) => {
    const userId = await consumeToken(tx, token, 'PASSWORD_RESET');
    if (!userId) throw new ApiError(400, 'RESET_LINK_INVALID', 'This reset link has expired or was already used. Ask for a new one.');
    const u = await tx.one('SELECT username FROM users WHERE user_id = ?', [userId]);
    await tx.query(`UPDATE users SET password_hash = ?, password_changed_at = NOW(), must_change_password = 0,
                    failed_login_count = 0, locked_until = IF(lock_reason = 'Too many wrong passwords', NULL, locked_until),
                    lock_reason = IF(lock_reason = 'Too many wrong passwords', NULL, lock_reason) WHERE user_id = ?`, [hash, userId]);
    const revoked = await sessions.revokeAll(userId, 'PASSWORD_RESET', { tx });
    await audit.record(tx, { id: userId, username: u.username }, 'PASSWORD_RESET', 'user', userId, null, { sessions_revoked: revoked });
    return { ok: true, message: 'Your password was changed. Sign in with the new password.' };
  });
}

/** An Admin creates a one-time reset link to hand to the person (and it is emailed when email is set up). */
async function adminResetLink(actor, userId) {
  const u = await one('SELECT user_id, username, email, anonymised_at FROM users WHERE user_id = ?', [userId]);
  if (!u || u.anonymised_at) throw ApiError.notFound('User');
  const token = await issueToken(null, userId, 'PASSWORD_RESET', ADMIN_RESET_HOURS * 60, actor.id);
  const url = link(`/reset-password?token=${token}`);
  await audit.record(null, actor, 'PASSWORD_RESET_LINK_ISSUED', 'user', userId, null, { valid_hours: ADMIN_RESET_HOURS });
  let emailed = false;
  if (notify.emailEnabled()) {
    emailed = (await notify.sendEmail(u.email, 'Reset your LOOP password',
      `A LOOP admin created a password reset link for your account. It works once, for ${ADMIN_RESET_HOURS} hours:\n\n${url}`)).sent;
  }
  return { url, path: `/reset-password?token=${token}`, expiresInHours: ADMIN_RESET_HOURS, emailed };
}

// ---------------------------------------------------------------- email verification
async function sendVerification(userId) {
  if (!notify.emailEnabled()) return { sent: false, reason: 'Email is not set up on this LOOP.' };
  const u = await one('SELECT email, email_verified_at FROM users WHERE user_id = ?', [userId]);
  if (!u || u.email_verified_at) return { sent: false, reason: 'Already verified.' };
  const token = await issueToken(null, userId, 'EMAIL_VERIFY', 48 * 60);
  const r = await notify.sendEmail(u.email, 'Confirm your email for LOOP', `Confirm this address for your LOOP account:\n\n${link(`/verify-email?token=${token}`)}`);
  return { sent: r.sent };
}

async function verifyEmail(token) {
  return withTransaction(async (tx) => {
    const userId = await consumeToken(tx, token, 'EMAIL_VERIFY');
    if (!userId) throw new ApiError(400, 'VERIFY_LINK_INVALID', 'This confirmation link has expired or was already used.');
    await tx.query('UPDATE users SET email_verified_at = NOW() WHERE user_id = ?', [userId]);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- published-password guard (SEC-01)
/** bcrypt hashes that appear in the repository (development seed and demo migrations). */
function publishedHashes() {
  const dir = path.resolve(__dirname, '../../../database');
  const files = [path.join(dir, '07_seed.sql'), ...fs.readdirSync(path.join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, 'migrations', f))];
  const out = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g)) out.add(m[0]);
  }
  return [...out];
}

/**
 * Accounts that still use a password published in the repository must choose a new one before they
 * can do anything else. Runs at startup and hourly when SEED_ACCOUNT_GUARD is on (default in production).
 * No account is deleted or deactivated.
 */
async function enforcePublishedPasswordGuard() {
  if (!seedGuard) return { flagged: 0, enabled: false };
  const hashes = publishedHashes();
  if (!hashes.length) return { flagged: 0, enabled: true };
  const rows = await query('SELECT user_id, username FROM users WHERE must_change_password = 0 AND anonymised_at IS NULL AND password_hash IN (?)', [hashes]);
  for (const r of rows) {
    await query('UPDATE users SET must_change_password = 1 WHERE user_id = ?', [r.user_id]);
    await sessions.revokeAll(r.user_id, 'PASSWORD_CHANGED');
    await audit.record(null, null, 'PUBLISHED_PASSWORD_BLOCKED', 'user', r.user_id, null, { username: r.username });
  }
  if (rows.length) log.warn('published_passwords_blocked', { accounts: rows.length });
  return { flagged: rows.length, enabled: true };
}

async function publishedPasswordAccounts() {
  const hashes = publishedHashes();
  if (!hashes.length) return [];
  return query(`SELECT u.user_id AS id, u.username, r.code AS role, u.is_active AS isActive, u.must_change_password AS mustChange
                  FROM users u JOIN roles r USING (role_id) WHERE u.password_hash IN (?) AND u.anonymised_at IS NULL`, [hashes]);
}

// ---------------------------------------------------------------- Admin: users
const USER_STATUS = {
  active: 'u.is_active = 1 AND (u.locked_until IS NULL OR u.locked_until <= NOW())',
  deactivated: 'u.is_active = 0 AND u.anonymised_at IS NULL',
  locked: 'u.locked_until > NOW()',
  anonymised: 'u.anonymised_at IS NOT NULL',
  password_change: 'u.must_change_password = 1',
};

async function listUsers({ q = '', role = null, status = null, page = 1, pageSize = 25, sort = 'newest' }) {
  const where = ['1 = 1']; const params = [];
  if (q) {
    where.push('(u.username LIKE ? OR p.display_name LIKE ? OR u.email LIKE ? OR u.user_id = ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, /^\d+$/.test(q) ? Number(q) : 0);
  }
  if (role) { where.push('r.code = ?'); params.push(role); }
  if (status && USER_STATUS[status]) where.push(USER_STATUS[status]);
  const order = { newest: 'u.user_id DESC', oldest: 'u.user_id ASC', name: 'p.display_name, u.user_id', last_login: 'u.last_login_at IS NULL, u.last_login_at DESC' }[sort] || 'u.user_id DESC';
  const from = 'FROM users u JOIN roles r ON r.role_id = u.role_id JOIN user_profiles p ON p.user_id = u.user_id';
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const users = await query(
    `SELECT u.user_id AS id, u.username, u.email, r.code AS role, u.is_active AS isActive, u.created_at AS createdAt,
            u.last_login_at AS lastLoginAt, p.display_name AS displayName, u.anonymised_at AS anonymisedAt,
            (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS locked, u.must_change_password AS mustChangePassword
       ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, users: users.map((x) => ({ ...x, isActive: !!x.isActive, locked: !!x.locked, mustChangePassword: !!x.mustChangePassword })) };
}

async function userDetail(userId) {
  const u = await one(
    `SELECT u.user_id AS id, u.username, u.email, r.code AS role, u.is_active AS isActive, u.created_at AS createdAt,
            u.last_login_at AS lastLoginAt, u.password_changed_at AS passwordChangedAt, u.locked_until AS lockedUntil,
            u.lock_reason AS lockReason, u.deactivation_reason AS deactivationReason, u.failed_login_count AS failedLogins,
            u.must_change_password AS mustChangePassword, u.email_verified_at AS emailVerifiedAt, u.anonymised_at AS anonymisedAt,
            u.terms_version AS termsVersion, u.terms_accepted_at AS termsAcceptedAt,
            p.display_name AS displayName, p.region_code AS region, p.content_filter AS contentFilter
       FROM users u JOIN roles r ON r.role_id = u.role_id JOIN user_profiles p ON p.user_id = u.user_id WHERE u.user_id = ?`, [userId]);
  if (!u) throw ApiError.notFound('User');
  const [activity, sessionsList, applications, uploads, reportsFiled, reportsAgainst, artists, history] = await Promise.all([
    one(`SELECT (SELECT COUNT(*) FROM listening_history WHERE user_id = ?) AS plays,
                (SELECT COUNT(*) FROM user_likes WHERE user_id = ?) AS likes,
                (SELECT COUNT(*) FROM playlists WHERE user_id = ?) AS playlists,
                (SELECT MAX(started_at) FROM listening_history WHERE user_id = ?) AS lastPlayedAt`, [userId, userId, userId, userId]),
    query(`SELECT session_id AS id, created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent
             FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() ORDER BY last_seen_at DESC`, [userId]),
    query(`SELECT application_id AS id, stage_name AS stageName, status, review_note AS reviewNote, submitted_at AS submittedAt
             FROM artist_applications WHERE user_id = ? ORDER BY application_id DESC`, [userId]),
    query(`SELECT upload_id AS id, title, status, created_at AS createdAt FROM artist_uploads WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [userId]),
    query(`SELECT report_id AS id, target_type AS targetType, target_id AS targetId, reason, status, created_at AS createdAt
             FROM content_reports WHERE reporter_user_id = ? ORDER BY report_id DESC LIMIT 20`, [userId]),
    query(`SELECT report_id AS id, reason, status, details, created_at AS createdAt
             FROM content_reports WHERE target_type = 'USER' AND target_id = ? ORDER BY report_id DESC LIMIT 20`, [userId]),
    query(`SELECT a.artist_id AS id, a.name, aa.account_status AS accountStatus FROM artist_accounts aa JOIN artists a USING (artist_id) WHERE aa.user_id = ?`, [userId]),
    audit.forEntity('user', userId, 40),
  ]);
  return { ...u, isActive: !!u.isActive, mustChangePassword: !!u.mustChangePassword, locked: !!(u.lockedUntil && new Date(u.lockedUntil) > new Date()),
    activity, sessions: sessionsList, applications, uploads, reportsFiled, reportsAgainst, artists, history };
}

async function lockedAdminsGuard(tx, userId, actorId, { demote = false, deactivate = false }) {
  const u = await tx.one('SELECT u.user_id, r.code AS role FROM users u JOIN roles r USING (role_id) WHERE u.user_id = ? FOR UPDATE OF u', [userId]);
  if (!u) throw ApiError.notFound('User');
  if ((demote || deactivate) && userId === actorId) throw new ApiError(409, 'SELF_LOCKOUT', 'You cannot remove or lock your own admin access.');
  if (u.role === 'ADMIN' && (demote || deactivate)) {
    const admins = await tx.query(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.code = 'ADMIN' AND u.is_active = 1 FOR UPDATE OF u`);
    if (admins.length <= 1) throw new ApiError(409, 'LAST_ADMIN', 'At least one active admin must remain.');
  }
  return u;
}

async function alertAdmins(tx, actor, text, userId) {
  await notify.notifyAdmins(tx, { kind: 'ADMIN_SECURITY', title: text, body: `Done by @${actor.username}.`, link: `/admin/users/${userId}` });
}

async function setActive(actor, userId, active, reason = null) {
  return withTransaction(async (tx) => {
    const u = await lockedAdminsGuard(tx, userId, actor.id, { deactivate: !active });
    if (!active && !reason) throw ApiError.badRequest('Give a reason for deactivating this account.');
    await tx.query('UPDATE users SET is_active = ?, deactivation_reason = ? WHERE user_id = ?', [active ? 1 : 0, active ? null : reason, userId]);
    if (!active) await sessions.revokeAll(userId, 'ADMIN_DEACTIVATED', { tx });
    await audit.record(tx, actor, active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', 'user', userId, null, { reason });
    if (u.role === 'ADMIN') await alertAdmins(tx, actor, `An admin account was ${active ? 'reactivated' : 'deactivated'}`, userId);
    return { id: userId, isActive: active };
  }, { actorId: actor.id });
}

async function setLock(actor, userId, locked, reason = null) {
  return withTransaction(async (tx) => {
    await lockedAdminsGuard(tx, userId, actor.id, { deactivate: locked });
    if (locked) {
      if (!reason) throw ApiError.badRequest('Give a reason for locking this account.');
      await tx.query("UPDATE users SET locked_until = '2999-12-31 00:00:00', lock_reason = ? WHERE user_id = ?", [reason, userId]);
      await sessions.revokeAll(userId, 'ADMIN_SIGNED_OUT', { tx });
    } else {
      await tx.query('UPDATE users SET locked_until = NULL, lock_reason = NULL, failed_login_count = 0 WHERE user_id = ?', [userId]);
    }
    await audit.record(tx, actor, locked ? 'USER_LOCKED' : 'USER_UNLOCKED', 'user', userId, null, { reason });
    return { id: userId, locked };
  }, { actorId: actor.id });
}

async function signOutEverywhere(actor, userId) {
  const n = await sessions.revokeAll(userId, 'ADMIN_SIGNED_OUT');
  await audit.record(null, actor, 'USER_SIGNED_OUT', 'user', userId, null, { sessions: n });
  return { id: userId, sessionsRevoked: n };
}

async function changeRole(actor, userId, role) {
  return withTransaction(async (tx) => {
    if (role === 'ADMIN') throw new ApiError(403, 'ADMIN_PROVISIONING_ONLY', 'Admin access is granted only with the server-side provisioning command.');
    const u = await lockedAdminsGuard(tx, userId, actor.id, { demote: true });
    if (u.role === role) return { id: userId, role };
    if (role === 'ARTIST') {
      const artist = await tx.one("SELECT 1 AS ok FROM artist_accounts WHERE user_id = ? AND account_status = 'ACTIVE' LIMIT 1", [userId]);
      if (!artist) throw new ApiError(409, 'ARTIST_PROFILE_REQUIRED', 'Approve an artist application (or link an artist profile) before giving Artist access.');
    }
    const r = await tx.one('SELECT role_id FROM roles WHERE code = ?', [role]);
    if (!r) throw new ApiError(400, 'INVALID_ROLE', 'Unknown role.');
    await tx.query('UPDATE users SET role_id = ? WHERE user_id = ?', [r.role_id, userId]);
    await audit.record(tx, actor, 'USER_ROLE_CHANGED', 'user', userId, { role: u.role }, { role });
    if (u.role === 'ADMIN') await alertAdmins(tx, actor, 'An admin was given a different role', userId);
    await notify.notify(tx, userId, { kind: 'ROLE_CHANGED', title: role === 'ARTIST' ? 'You now have Artist access' : 'Your LOOP access changed',
      body: role === 'ARTIST' ? 'Open the Artist studio to manage your profile and recordings.' : 'Your account is now a User account.', link: role === 'ARTIST' ? '/studio' : '/discover' });
    return { id: userId, role };
  }, { actorId: actor.id });
}

/**
 * Anonymise: remove the person, keep the legal records. Username/email/profile are replaced,
 * listening, search, likes, ratings, playlists and preferences are deleted, sessions revoked.
 * Artist uploads, rights declarations and reports stay, attached to the pseudonymous account.
 */
async function anonymise(actor, userId, reason) {
  return withTransaction(async (tx) => {
    const u = await lockedAdminsGuard(tx, userId, actor.id, { deactivate: actor.id !== userId });
    const before = await tx.one('SELECT username, anonymised_at FROM users WHERE user_id = ?', [userId]);
    if (before.anonymised_at) throw new ApiError(409, 'ALREADY_ANONYMISED', 'This account is already anonymised.');
    if (u.role === 'ADMIN' && actor.id === userId) {
      const admins = await tx.query(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.code = 'ADMIN' AND u.is_active = 1 FOR UPDATE OF u`);
      if (admins.length <= 1) throw new ApiError(409, 'LAST_ADMIN', 'At least one active admin must remain.');
    }
    const pseudo = `deleted_${userId}`;
    const listener = await tx.one("SELECT role_id FROM roles WHERE code = 'LISTENER'");
    const randomHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    await tx.query(`UPDATE users SET username = ?, email = ?, password_hash = ?, is_active = 0, role_id = ?, anonymised_at = NOW(),
                    deactivation_reason = ?, email_verified_at = NULL, must_change_password = 0 WHERE user_id = ?`,
      [pseudo, `${pseudo}@invalid.loop`, randomHash, listener.role_id, reason || 'Anonymised', userId]);
    await tx.query("UPDATE user_profiles SET display_name = 'Deleted account', region_code = NULL WHERE user_id = ?", [userId]);
    for (const sql of [
      'DELETE FROM listening_history WHERE user_id = ?', 'DELETE FROM listening_sessions WHERE user_id = ?', 'DELETE FROM search_history WHERE user_id = ?',
      'DELETE FROM user_likes WHERE user_id = ?', 'DELETE FROM ratings WHERE user_id = ?', 'DELETE FROM song_dismissals WHERE user_id = ?',
      'DELETE FROM playlists WHERE user_id = ?', 'DELETE FROM recommendation_batches WHERE user_id = ?', 'DELETE FROM user_languages WHERE user_id = ?',
      'DELETE FROM user_genre_preferences WHERE user_id = ?', 'DELETE FROM user_artist_preferences WHERE user_id = ?',
      'DELETE FROM user_mood_preferences WHERE user_id = ?', 'DELETE FROM user_context_preferences WHERE user_id = ?',
      'DELETE FROM notifications WHERE user_id = ?', 'DELETE FROM account_tokens WHERE user_id = ?', 'DELETE FROM retired_feature_archive WHERE user_id = ?',
    ]) await tx.query(sql, [userId]);
    await sessions.revokeAll(userId, 'ACCOUNT_ANONYMISED', { tx });
    await tx.query("UPDATE artist_accounts SET account_status = 'SUSPENDED', suspended_reason = 'Account anonymised', suspended_at = NOW() WHERE user_id = ?", [userId]);
    await audit.record(tx, actor, 'USER_ANONYMISED', 'user', userId, { username: before.username }, { reason });
    return { id: userId, anonymised: true };
  }, { actorId: actor.id });
}

// ---------------------------------------------------------------- listener data controls
async function clearSearchHistory(userId) {
  const r = await query('DELETE FROM search_history WHERE user_id = ?', [userId]);
  return { cleared: r.affectedRows };
}

async function clearListeningHistory(userId) {
  return withTransaction(async (tx) => {
    await tx.query('SELECT user_id FROM users WHERE user_id = ? FOR UPDATE', [userId]);
    const r = await tx.query('DELETE FROM listening_history WHERE user_id = ?', [userId]);
    await tx.query('DELETE FROM listening_sessions WHERE user_id = ?', [userId]);
    await tx.call('sp_refresh_user_preferences_core', [userId]);
    return { cleared: r.affectedRows };
  });
}

async function privacySummary(userId) {
  return one(`SELECT (SELECT COUNT(*) FROM search_history WHERE user_id = ?) AS searches,
                     (SELECT COUNT(*) FROM listening_history WHERE user_id = ?) AS plays,
                     (SELECT query_text FROM search_history WHERE user_id = ? ORDER BY search_id DESC LIMIT 1) AS lastSearch`, [userId, userId, userId]);
}

/** Everything LOOP holds about the signed-in person, as JSON. */
async function exportData(userId) {
  const [profile, likes, playlists, history, searches, ratings, applications, uploads, reports] = await Promise.all([
    one(`SELECT u.username, u.email, u.created_at, up.display_name, up.region_code, up.content_filter, up.listening_habit
           FROM users u JOIN user_profiles up USING (user_id) WHERE u.user_id = ?`, [userId]),
    query('SELECT s.title, ul.liked_at FROM user_likes ul JOIN songs s USING (song_id) WHERE ul.user_id = ?', [userId]),
    query(`SELECT p.name, p.description, p.created_at, (SELECT JSON_ARRAYAGG(s.title) FROM playlist_songs ps JOIN songs s USING (song_id)
             WHERE ps.playlist_id = p.playlist_id) AS songs FROM playlists p WHERE p.user_id = ?`, [userId]),
    query('SELECT s.title, lh.started_at, lh.listened_sec FROM listening_history lh JOIN songs s USING (song_id) WHERE lh.user_id = ? ORDER BY lh.started_at DESC LIMIT 5000', [userId]),
    query('SELECT query_text, searched_at FROM search_history WHERE user_id = ? ORDER BY search_id DESC LIMIT 5000', [userId]),
    query('SELECT s.title, r.rating FROM ratings r JOIN songs s USING (song_id) WHERE r.user_id = ?', [userId]),
    query('SELECT stage_name, status, submitted_at FROM artist_applications WHERE user_id = ?', [userId]),
    query('SELECT title, status, created_at FROM artist_uploads WHERE user_id = ?', [userId]),
    query('SELECT target_type, reason, status, created_at FROM content_reports WHERE reporter_user_id = ?', [userId]),
  ]);
  return { exportedAt: new Date().toISOString(), profile, likes, ratings, playlists, listeningHistory: history, searchHistory: searches, artistApplications: applications, uploads, reports };
}

module.exports = {
  requestReset, resetPassword, adminResetLink, sendVerification, verifyEmail,
  enforcePublishedPasswordGuard, publishedPasswordAccounts, publishedHashes,
  listUsers, userDetail, setActive, setLock, signOutEverywhere, changeRole, anonymise,
  clearSearchHistory, clearListeningHistory, privacySummary, exportData,
};
