// User-facing notifications: always stored in the in-app inbox; also emailed when an email
// provider is configured (RESEND_API_KEY + EMAIL_FROM). Email failures are logged, never fatal.
const { query, one } = require('../config/db');
const { email: emailCfg, publicOrigin } = require('../config/env');
const log = require('../utils/log');

const emailEnabled = () => !!(emailCfg.resendApiKey && emailCfg.from);

async function sendEmail(to, subject, text) {
  if (!emailEnabled()) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${emailCfg.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: emailCfg.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('email_failed', { status: res.status });
      return { sent: false, reason: `provider_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    log.warn('email_failed', { error: err.message });
    return { sent: false, reason: 'network' };
  }
}

const absolute = (link) => (link && publicOrigin && link.startsWith('/') ? `${publicOrigin}${link}` : link);

/** Store an inbox message and (optionally) email it. runner: a transaction, or null. */
async function notify(runner, userId, { kind, title, body = null, link = null, email = false }) {
  const run = runner ? runner.query : query;
  await run('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)',
    [userId, kind, title.slice(0, 140), body ? body.slice(0, 600) : null, link]);
  if (email && emailEnabled()) {
    const u = await one('SELECT email FROM users WHERE user_id = ? AND anonymised_at IS NULL', [userId]);
    if (u) setImmediate(() => sendEmail(u.email, title, [body, absolute(link)].filter(Boolean).join('\n\n')));
  }
}

/** Every active Admin gets the message (new applications, uploads, reports). */
async function notifyAdmins(runner, message) {
  const run = runner ? runner.query : query;
  const admins = await run(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.code = 'ADMIN' AND u.is_active = 1`);
  for (const a of admins) await notify(runner, a.user_id, message);
}

async function list(userId, { limit = 30 } = {}) {
  const [items, [{ unread }]] = await Promise.all([
    query(`SELECT notification_id AS id, kind, title, body, link, created_at AS createdAt, read_at AS readAt
             FROM notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT ?`, [userId, limit]),
    query('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]),
  ]);
  return { unread, items };
}

async function markRead(userId, ids = null) {
  if (ids && ids.length) await query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL AND notification_id IN (?)', [userId, ids]);
  else await query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [userId]);
  return list(userId);
}

module.exports = { notify, notifyAdmins, list, markRead, sendEmail, emailEnabled };
