// Registration, login (with brute-force protection), password changes and the signed-in profile.
// Passwords are hashed with bcrypt (cost 10); the plaintext never reaches SQL.
const bcrypt = require('bcryptjs');
const { query, one, withTransaction } = require('../config/db');
const sessions = require('./sessionService');
const audit = require('./auditService');
const settings = require('./settingsService');
const ApiError = require('../utils/ApiError');
const { isWeakPassword } = require('../utils/passwordPolicy');

const MAX_FAILED = 5;
// Progressive lock: 1, 5, then 15 minutes for repeated rounds of five wrong passwords.
const LOCK_STEPS = [1, 5, 15];
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);
const TERMS_VERSION = 'LOOP-TERMS-2026-11';

async function register({ username, email, password, displayName, acceptTerms }, client = {}) {
  if (!(await settings.get('registration_open'))) throw new ApiError(403, 'REGISTRATION_CLOSED', 'LOOP is not accepting new accounts right now.');
  if (acceptTerms !== true) throw ApiError.badRequest('Accept the Terms of use and Privacy notice to create an account.', { acceptTerms: 'Required' });
  if (isWeakPassword(password)) throw ApiError.badRequest('That password is too common. Choose another.', { password: 'Too common' });
  const hash = await bcrypt.hash(password, 10);
  const { userId, s } = await withTransaction(async (tx) => {
    const role = await tx.one("SELECT role_id FROM roles WHERE code = 'LISTENER'");
    const r = await tx.query(
      `INSERT INTO users (username, email, password_hash, password_changed_at, role_id, terms_version, terms_accepted_at)
       VALUES (?, ?, ?, NOW(), ?, ?, NOW())`, [username, email, hash, role.role_id, TERMS_VERSION]);
    await tx.query('INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)', [r.insertId, displayName]);
    await audit.record(tx, { id: r.insertId, username }, 'ACCOUNT_REGISTERED', 'user', r.insertId, null, { terms_version: TERMS_VERSION },
      client.ip ? sessions.ipHash(client.ip) : null);
    return { userId: r.insertId, s: await sessions.create(r.insertId, client, tx) };   // account + session, all or nothing
  });
  return { session: s, user: await profile(userId), userId };
}

/**
 * Login by username or email. The password is checked BEFORE anything about the account is
 * revealed, so "deactivated" and "locked" never confirm that an account exists to a stranger.
 */
async function login({ login: id, password }, client = {}) {
  const u = await one(
    `SELECT u.user_id, u.username, u.password_hash, u.is_active, u.failed_login_count, u.locked_until, u.lock_reason,
            u.locked_until IS NOT NULL AND u.locked_until > NOW() AS is_locked,
            CEIL(TIMESTAMPDIFF(SECOND, NOW(), u.locked_until) / 60) AS minutes_left
       FROM users u WHERE (u.username = ? OR u.email = ?) AND u.anonymised_at IS NULL`, [id.toLowerCase(), id.toLowerCase()]);
  const ipHash = client.ip ? sessions.ipHash(client.ip) : null;
  const invalid = new ApiError(401, 'INVALID_LOGIN', 'That username or password is not right.');
  if (!u) { await bcrypt.compare(password, DUMMY_HASH); throw invalid; }   // equal timing for unknown accounts
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    if (!u.is_locked) {
      const failed = u.failed_login_count + 1;
      const round = Math.floor(failed / MAX_FAILED);
      const lockMinutes = failed % MAX_FAILED === 0 ? LOCK_STEPS[Math.min(round - 1, LOCK_STEPS.length - 1)] : 0;
      await query(
        `UPDATE users SET failed_login_count = LEAST(?, 250), locked_until = IF(? > 0, NOW() + INTERVAL ? MINUTE, locked_until),
                lock_reason = IF(? > 0, 'Too many wrong passwords', lock_reason) WHERE user_id = ?`,
        [failed, lockMinutes, lockMinutes, lockMinutes, u.user_id]);
    }
    await audit.record(null, { id: u.user_id, username: u.username }, 'LOGIN_FAILED', 'user', u.user_id, null, null, ipHash);
    throw invalid;
  }
  // Correct password: now it is safe to say why the account cannot sign in.
  if (!u.is_active) throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated. Contact LOOP support if you think this is a mistake.');
  if (u.is_locked) {
    throw new ApiError(429, 'ACCOUNT_LOCKED', u.lock_reason && u.lock_reason !== 'Too many wrong passwords'
      ? 'This account is locked by LOOP. Contact support.'
      : `Too many wrong passwords. Try again in ${u.minutes_left} minute${u.minutes_left === 1 ? '' : 's'}.`);
  }
  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL, lock_reason = NULL, last_login_at = NOW() WHERE user_id = ?', [u.user_id]);
  const s = await sessions.create(u.user_id, client);
  await audit.record(null, { id: u.user_id, username: u.username }, 'LOGIN_SUCCEEDED', 'user', u.user_id, null, null, ipHash);
  return { session: s, user: await profile(u.user_id) };
}

/** Verify the current password of a signed-in user (for sensitive account actions). */
async function checkPassword(userId, password) {
  const u = await one('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    throw new ApiError(400, 'WRONG_PASSWORD', 'Your current password is not right.');
  }
}

/** Step-up: re-enter the password on this session before privileged Admin actions. */
async function reauthenticate(user, sessionId, password) {
  await checkPassword(user.id, password).catch(() => { throw new ApiError(400, 'WRONG_PASSWORD', 'That password is not right.'); });
  await sessions.markReauthenticated(sessionId);
  await audit.record(null, user, 'REAUTHENTICATED', 'user', user.id);
  return { ok: true };
}

/** Change password; every other session of the user is revoked in the same transaction. */
async function changePassword(userId, currentSessionId, { currentPassword, newPassword }) {
  await checkPassword(userId, currentPassword);
  if (currentPassword === newPassword) throw ApiError.badRequest('The new password must be different from the current one.');
  if (isWeakPassword(newPassword)) throw ApiError.badRequest('That password is too common or publicly known. Choose another.');
  const hash = await bcrypt.hash(newPassword, 10);
  return withTransaction(async (tx) => {
    const u = await tx.one('SELECT username FROM users WHERE user_id = ?', [userId]);
    await tx.query('UPDATE users SET password_hash = ?, password_changed_at = NOW(), must_change_password = 0 WHERE user_id = ?', [hash, userId]);
    const revoked = await sessions.revokeAll(userId, 'PASSWORD_CHANGED', { except: currentSessionId, tx });
    await audit.record(tx, { id: userId, username: u.username }, 'PASSWORD_CHANGED', 'user', userId, null, { other_sessions_revoked: revoked });
    return { changed: true, otherSessionsRevoked: revoked };
  });
}

/**
 * Delete a listener's account. Accounts with artist uploads keep those legal records, so they
 * are anonymised instead (see accountService.anonymise) — the person still gets their data removed.
 */
async function deleteAccount(userId, { password }) {
  await checkPassword(userId, password);
  const records = await one('SELECT (SELECT COUNT(*) FROM artist_uploads WHERE user_id = ?) + (SELECT COUNT(*) FROM artist_rights_reports WHERE reporter_user_id = ?) AS n', [userId, userId]);
  const me = await one('SELECT u.user_id, u.username, r.code FROM users u JOIN roles r USING (role_id) WHERE u.user_id = ?', [userId]);
  if (!me) throw ApiError.notFound('User');
  if (me.code === 'ADMIN') {
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM users u JOIN roles r USING (role_id) WHERE r.code = 'ADMIN' AND u.is_active = 1");
    if (n <= 1) throw new ApiError(409, 'LAST_ADMIN', 'You are the last active admin; provision another admin first.');
  }
  if (Number(records.n) > 0) {
    // eslint-disable-next-line global-require
    await require('./accountService').anonymise({ id: userId, username: me.username }, userId, 'Deleted by the account holder');
    return { deleted: true, anonymised: true };
  }
  return withTransaction(async (tx) => {
    await audit.record(tx, null, 'ACCOUNT_DELETED', 'user', userId, { username: me.username });
    await tx.query('DELETE FROM retired_feature_archive WHERE user_id = ?', [userId]);
    await tx.query('DELETE FROM users WHERE user_id = ?', [userId]);
    return { deleted: true, anonymised: false };
  });
}

async function profile(userId) {
  const u = await one(
    `SELECT u.user_id, u.username, u.email, u.created_at, u.must_change_password, u.email_verified_at, r.code AS role_code, r.name AS role_name,
            up.display_name, up.region_code, rg.name AS region_name, up.content_filter, up.listening_habit,
            up.onboarding_completed_at,
            (SELECT JSON_ARRAYAGG(permission_code) FROM role_permissions rp WHERE rp.role_id = u.role_id) AS permissions
       FROM users u JOIN roles r ON r.role_id = u.role_id JOIN user_profiles up ON up.user_id = u.user_id
       LEFT JOIN regions rg ON rg.region_code = up.region_code
      WHERE u.user_id = ?`, [userId]);
  if (!u) throw ApiError.notFound('User');
  const languages = await query(
    `SELECT l.language_id AS id, l.name, l.native_name AS nativeName, ul.priority
       FROM user_languages ul JOIN languages l ON l.language_id = ul.language_id WHERE ul.user_id = ? ORDER BY ul.priority`, [userId]);
  const perms = typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions || [];
  return {
    id: u.user_id, username: u.username, email: u.email, displayName: u.display_name, role: u.role_code, roleName: u.role_name,
    permissions: perms, region: u.region_code ? { code: u.region_code, name: u.region_name } : null, languages,
    contentFilter: u.content_filter, listeningHabit: u.listening_habit, onboarded: !!u.onboarding_completed_at,
    memberSince: u.created_at, mustChangePassword: !!u.must_change_password, emailVerified: !!u.email_verified_at,
  };
}

module.exports = { register, login, profile, checkPassword, reauthenticate, changePassword, deleteAccount, MAX_FAILED, LOCK_MINUTES, TERMS_VERSION };
