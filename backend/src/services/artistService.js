// Artists as people: applications, the artist profile, name-change review and suspension.
// The upload pipeline lives in uploadService.js.
const { query, one, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const audit = require('./auditService');
const notify = require('./notifyService');
const settings = require('./settingsService');
const { localMedia } = require('../providers');

const TERMS_VERSION = 'LOOP-ARTIST-RIGHTS-1.0';

function activeArtistAccount(runner, userId, artistId) {
  return (runner ? runner.one : one)(
    `SELECT aa.artist_id AS artistId, a.name AS artistName
       FROM artist_accounts aa JOIN artists a USING (artist_id) JOIN users u ON u.user_id = aa.user_id
      WHERE aa.user_id = ? AND aa.artist_id = ? AND aa.account_status = 'ACTIVE' AND u.is_active = 1`, [userId, artistId]);
}

async function myProfile(userId) {
  const [applications, artists, uploads, nameChanges, cfg] = await Promise.all([
    query(`SELECT application_id AS id, stage_name AS stageName, status, review_note AS reviewNote,
                  submitted_at AS submittedAt, reviewed_at AS reviewedAt
             FROM artist_applications WHERE user_id = ? ORDER BY application_id DESC`, [userId]),
    query(`SELECT a.artist_id AS id, a.name, a.artist_type AS type, a.bio, a.formed_year AS formedYear,
                  aa.account_status AS accountStatus, aa.suspended_reason AS suspendedReason, aa.created_at AS linkedAt
             FROM artist_accounts aa JOIN artists a USING (artist_id)
            WHERE aa.user_id = ? ORDER BY a.name`, [userId]),
    query(`SELECT upload_id AS id, artist_id AS artistId, title, version_label AS versionLabel, status, scan_status AS scanStatus,
                  review_note AS reviewNote, failure_reason AS failureReason, created_at AS createdAt, updated_at AS updatedAt,
                  duration_verified_sec AS durationSec, file_size AS fileSize, song_id AS songId, genre_id AS genreId,
                  language_id AS languageId, release_year AS releaseYear, explicit, description
             FROM artist_uploads WHERE user_id = ? AND source = 'ARTIST' ORDER BY created_at DESC LIMIT 100`, [userId]),
    query(`SELECT nc.request_id AS id, nc.artist_id AS artistId, nc.old_name AS oldName, nc.new_name AS newName, nc.status,
                  nc.review_note AS reviewNote, nc.created_at AS createdAt
             FROM artist_name_changes nc JOIN artist_accounts aa ON aa.artist_id = nc.artist_id AND aa.user_id = ?
            ORDER BY nc.request_id DESC LIMIT 20`, [userId]),
    settings.all(),
  ]);
  const storage = localMedia.check();
  const cooldown = cooldownUntil(applications, cfg.application_cooldown_days);
  return {
    applications, artists, uploads: uploads.map((u) => ({ ...u, explicit: !!u.explicit })), nameChanges, termsVersion: TERMS_VERSION,
    maxUploadBytes: cfg.upload_max_mb * 1024 * 1024, applicationsOpen: cfg.artist_applications_open, reapplyAfter: cooldown,
    uploadsEnabled: storage.writable,
    uploadsDisabledReason: storage.writable ? null
      : storage.state === 'ephemeral' ? 'Uploads are paused until LOOP’s audio storage is moved to a persistent volume.'
        : 'Audio uploads are switched off on this deployment.',
  };
}

function cooldownUntil(applications, days) {
  const lastRejected = applications.find((a) => a.status === 'REJECTED');
  if (!lastRejected || !days) return null;
  const until = new Date(new Date(lastRejected.reviewedAt || lastRejected.submittedAt).getTime() + days * 86400000);
  return until > new Date() ? until.toISOString() : null;
}

/**
 * An Artist edits their public profile. Bio, type and year change at once; a NAME change becomes a
 * request an Admin reviews, so an approved artist cannot rename themselves into someone else.
 */
async function updateProfile(user, artistId, data) {
  return withTransaction(async (tx) => {
    const linked = await activeArtistAccount(tx, user.id, artistId);
    if (!linked) throw ApiError.forbidden('You can only edit an active artist profile linked to your account.');
    const before = await tx.one('SELECT name, artist_type, bio, formed_year FROM artists WHERE artist_id = ? FOR UPDATE', [artistId]);
    const map = { artistType: 'artist_type', bio: 'bio', formedYear: 'formed_year' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (data[k] === undefined) continue;
      sets.push(`${col} = ?`); params.push(data[k] === '' ? null : data[k]);
    }
    let nameChange = null;
    if (data.name !== undefined && data.name.trim() !== before.name) {
      await tx.query("UPDATE artist_name_changes SET status = 'CANCELLED' WHERE artist_id = ? AND status = 'PENDING'", [artistId]);
      const r = await tx.query('INSERT INTO artist_name_changes (artist_id, requested_by, old_name, new_name, reason) VALUES (?, ?, ?, ?, ?)',
        [artistId, user.id, before.name, data.name.trim(), data.nameReason || null]);
      nameChange = { id: r.insertId, status: 'PENDING', newName: data.name.trim() };
      await audit.record(tx, user, 'ARTIST_NAME_CHANGE_REQUESTED', 'artist', artistId, { name: before.name }, { name: data.name.trim() });
      await notify.notifyAdmins(tx, { kind: 'ADMIN_NAME_CHANGE', title: `Name change requested: “${before.name}” → “${data.name.trim()}”`, link: `/admin/artists/${artistId}` });
    }
    if (!sets.length && !nameChange) throw ApiError.badRequest('Nothing to update.');
    if (sets.length) {
      await tx.query(`UPDATE artists SET ${sets.join(', ')} WHERE artist_id = ?`, [...params, artistId]);
      await audit.record(tx, user, 'ARTIST_PROFILE_UPDATED', 'artist', artistId, before, { artistType: data.artistType, bio: data.bio, formedYear: data.formedYear });
    }
    return { id: artistId, updated: sets.length > 0, nameChange };
  }, { actorId: user.id });
}

async function apply(user, data) {
  const cfg = await settings.all();
  if (!cfg.artist_applications_open) throw new ApiError(403, 'APPLICATIONS_CLOSED', 'LOOP is not accepting artist applications right now.');
  return withTransaction(async (tx) => {
    const account = await tx.one('SELECT r.code AS role FROM users u JOIN roles r USING (role_id) WHERE u.user_id = ? AND u.is_active = 1 FOR UPDATE OF u', [user.id]);
    if (!account) throw ApiError.unauthorized();
    if (account.role !== 'LISTENER') throw ApiError.forbidden('Only an active User account can apply for Artist access.');
    const existingArtist = await tx.one("SELECT 1 AS ok FROM artist_accounts WHERE user_id = ? AND account_status = 'ACTIVE' LIMIT 1", [user.id]);
    if (existingArtist) throw ApiError.conflict('ARTIST_ALREADY_ACTIVE', 'This account already has an active artist profile.');
    const previous = await tx.query('SELECT status, submitted_at AS submittedAt, reviewed_at AS reviewedAt FROM artist_applications WHERE user_id = ? ORDER BY application_id DESC', [user.id]);
    if (previous.some((a) => a.status === 'PENDING')) throw ApiError.conflict('APPLICATION_PENDING', 'You already have an artist application awaiting review.');
    const until = cooldownUntil(previous, cfg.application_cooldown_days);
    if (until) throw new ApiError(429, 'APPLICATION_COOLDOWN', `You can apply again after ${new Date(until).toDateString()}.`);
    const r = await tx.query(
      `INSERT INTO artist_applications (user_id, stage_name, artist_type, country_code, bio, website_url, proof_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.id, data.stageName, data.artistType || 'SOLO', data.countryCode || 'IN', data.bio || null, data.websiteUrl || null, data.proofUrl || null]);
    await audit.record(tx, user, 'ARTIST_APPLICATION_SUBMITTED', 'artist_application', r.insertId, null, { stage_name: data.stageName });
    await notify.notifyAdmins(tx, { kind: 'ADMIN_APPLICATION', title: `New artist application: ${data.stageName}`, link: '/admin/applications' });
    return { id: r.insertId, status: 'PENDING', message: 'Your artist application has been sent for review.' };
  }, { actorId: user.id });
}

async function withdrawApplication(user, applicationId) {
  return withTransaction(async (tx) => {
    const a = await tx.one('SELECT status FROM artist_applications WHERE application_id = ? AND user_id = ? FOR UPDATE', [applicationId, user.id]);
    if (!a) throw ApiError.notFound('Application');
    if (a.status !== 'PENDING') throw ApiError.conflict('APPLICATION_ALREADY_REVIEWED', 'Only a waiting application can be withdrawn.');
    await tx.query("UPDATE artist_applications SET status = 'WITHDRAWN', reviewed_at = NOW() WHERE application_id = ?", [applicationId]);
    await audit.record(tx, user, 'ARTIST_APPLICATION_WITHDRAWN', 'artist_application', applicationId);
    return { id: applicationId, status: 'WITHDRAWN' };
  }, { actorId: user.id });
}

async function listApplications({ status = 'PENDING', q = '', page = 1, pageSize = 25 }) {
  const where = ["(? = 'ALL' OR aa.status = ?)"]; const params = [status, status];
  if (q) { where.push('(aa.stage_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const from = 'FROM artist_applications aa JOIN users u USING (user_id) JOIN user_profiles p USING (user_id)';
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT aa.application_id AS id, aa.user_id AS userId, u.username, u.email, u.is_active AS userActive,
            p.display_name AS displayName, aa.stage_name AS stageName, aa.artist_type AS artistType,
            aa.country_code AS countryCode, aa.bio, aa.website_url AS websiteUrl, aa.proof_url AS proofUrl,
            aa.status, aa.review_note AS reviewNote, aa.submitted_at AS submittedAt, aa.reviewed_at AS reviewedAt, aa.artist_id AS artistId,
            (SELECT COUNT(*) FROM artist_applications x WHERE x.user_id = aa.user_id AND x.application_id < aa.application_id) AS previousApplications,
            (SELECT COUNT(*) FROM artist_applications x WHERE x.user_id = aa.user_id AND x.status = 'REJECTED') AS previousRejections,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', ar.artist_id, 'name', ar.name, 'disambiguation', ar.disambiguation,
                     'linked', EXISTS (SELECT 1 FROM artist_accounts ac WHERE ac.artist_id = ar.artist_id AND ac.account_status = 'ACTIVE')))
               FROM artists ar WHERE LOWER(ar.name) = LOWER(aa.stage_name)) AS sameNameArtists
       ${from} WHERE ${where.join(' AND ')} ORDER BY aa.submitted_at ${status === 'PENDING' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, applications: rows.map((r) => ({ ...r, userActive: !!r.userActive,
    sameNameArtists: (typeof r.sameNameArtists === 'string' ? JSON.parse(r.sameNameArtists) : r.sameNameArtists) || [] })) };
}

/** A disambiguation listeners can understand: none when the name is free, else the country, else a number. */
async function freeDisambiguation(tx, name, country) {
  for (const d of ['', country, `${country} 2`, `${country} 3`]) {
    const clash = await tx.one('SELECT 1 AS x FROM artists WHERE LOWER(name) = LOWER(?) AND disambiguation = ?', [name, d]);
    if (!clash) return d;
  }
  return `${country} ${Date.now() % 100000}`;
}

/**
 * Approve or reject. Approval either creates a new artist or links the applicant to an existing
 * catalogue artist (an artist claiming their profile). The Admin can correct the stage name.
 */
async function decideApplication(actor, applicationId, { action, note = null, stageName = null, linkArtistId = null }) {
  if (action === 'REJECT' && !String(note || '').trim()) throw ApiError.badRequest('Tell the applicant why their application was rejected.');
  return withTransaction(async (tx) => {
    const a = await tx.one('SELECT * FROM artist_applications WHERE application_id = ? FOR UPDATE', [applicationId]);
    if (!a) throw ApiError.notFound('Artist application');
    if (a.status !== 'PENDING') throw ApiError.conflict('APPLICATION_ALREADY_REVIEWED', 'This application is no longer awaiting review.');
    if (action === 'REJECT') {
      await tx.query(`UPDATE artist_applications SET status = 'REJECTED', reviewer_user_id = ?, review_note = ?, reviewed_at = NOW() WHERE application_id = ?`, [actor.id, note, applicationId]);
      await audit.record(tx, actor, 'ARTIST_APPLICATION_REJECTED', 'artist_application', applicationId, null, { user_id: a.user_id, note });
      await notify.notify(tx, a.user_id, { kind: 'APPLICATION_REJECTED', title: 'Your artist application was not approved', body: note, link: '/settings/artist', email: true });
      return { id: applicationId, status: 'REJECTED' };
    }
    if (action !== 'APPROVE') throw ApiError.badRequest('Decision must be APPROVE or REJECT.');
    const user = await tx.one('SELECT u.user_id, u.is_active, r.code AS role FROM users u JOIN roles r USING (role_id) WHERE u.user_id = ? FOR UPDATE OF u', [a.user_id]);
    if (!user || !user.is_active) throw ApiError.conflict('ARTIST_ACCOUNT_INACTIVE', 'This account is inactive and cannot be approved.');
    if (user.role !== 'LISTENER') throw ApiError.conflict('APPLICANT_ROLE_CHANGED', `This person is now ${user.role === 'ADMIN' ? 'an Admin' : 'an Artist'}; their role cannot be changed by an application.`);
    let artistId;
    const name = (stageName || a.stage_name).trim();
    if (linkArtistId) {
      const target = await tx.one('SELECT artist_id FROM artists WHERE artist_id = ? FOR UPDATE', [linkArtistId]);
      if (!target) throw ApiError.notFound('Artist to link');
      const taken = await tx.one("SELECT user_id FROM artist_accounts WHERE artist_id = ? AND account_status = 'ACTIVE' AND user_id <> ?", [linkArtistId, a.user_id]);
      if (taken) throw ApiError.conflict('ARTIST_ALREADY_CLAIMED', 'Another active account already manages this artist.');
      artistId = linkArtistId;
    } else {
      const made = await tx.query('INSERT INTO artists (name, disambiguation, artist_type, country_code, bio) VALUES (?, ?, ?, ?, ?)',
        [name, await freeDisambiguation(tx, name, a.country_code), a.artist_type, a.country_code, a.bio]);
      artistId = made.insertId;
    }
    await tx.query(`INSERT INTO artist_accounts (user_id, artist_id) VALUES (?, ?)
                    ON DUPLICATE KEY UPDATE account_status = 'ACTIVE', suspended_reason = NULL, suspended_at = NULL, suspended_by = NULL`, [a.user_id, artistId]);
    const role = await tx.one("SELECT role_id FROM roles WHERE code = 'ARTIST'");
    await tx.query('UPDATE users SET role_id = ? WHERE user_id = ?', [role.role_id, a.user_id]);
    await tx.query(`UPDATE artist_applications SET status = 'APPROVED', stage_name = ?, artist_id = ?, reviewer_user_id = ?, review_note = ?, reviewed_at = NOW() WHERE application_id = ?`,
      [name, artistId, actor.id, note, applicationId]);
    await audit.record(tx, actor, 'ARTIST_APPLICATION_APPROVED', 'artist_application', applicationId, null, { user_id: a.user_id, artist_id: artistId, linked_existing: !!linkArtistId });
    await notify.notify(tx, a.user_id, { kind: 'APPLICATION_APPROVED', title: 'You now have Artist access on LOOP', body: 'Open the Artist studio to complete your profile and upload your first recording.', link: '/studio', email: true });
    return { id: applicationId, artistId, status: 'APPROVED', userId: a.user_id };
  }, { actorId: actor.id });
}

// ---------------------------------------------------------------- name changes (Admin)
async function listNameChanges({ status = 'PENDING', page = 1, pageSize = 25 }) {
  const [{ total }] = await query("SELECT COUNT(*) AS total FROM artist_name_changes WHERE (? = 'ALL' OR status = ?)", [status, status]);
  const rows = await query(
    `SELECT nc.request_id AS id, nc.artist_id AS artistId, nc.old_name AS oldName, nc.new_name AS newName, nc.reason, nc.status,
            nc.review_note AS reviewNote, nc.created_at AS createdAt, u.username AS requestedBy,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.artist_id, 'name', a.name)) FROM artists a
              WHERE LOWER(a.name) = LOWER(nc.new_name) AND a.artist_id <> nc.artist_id) AS clashes
       FROM artist_name_changes nc LEFT JOIN users u ON u.user_id = nc.requested_by
      WHERE (? = 'ALL' OR nc.status = ?) ORDER BY nc.request_id DESC LIMIT ? OFFSET ?`, [status, status, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, requests: rows.map((r) => ({ ...r, clashes: (typeof r.clashes === 'string' ? JSON.parse(r.clashes) : r.clashes) || [] })) };
}

async function decideNameChange(actor, requestId, { action, note = null }) {
  if (action === 'REJECT' && !String(note || '').trim()) throw ApiError.badRequest('Give the artist a reason.');
  return withTransaction(async (tx) => {
    const r = await tx.one('SELECT * FROM artist_name_changes WHERE request_id = ? FOR UPDATE', [requestId]);
    if (!r) throw ApiError.notFound('Name change request');
    if (r.status !== 'PENDING') throw ApiError.conflict('ALREADY_DECIDED', 'This request was already decided.');
    if (action === 'APPROVE') {
      await tx.query('UPDATE artists SET name = ? WHERE artist_id = ?', [r.new_name, r.artist_id]);
    }
    await tx.query('UPDATE artist_name_changes SET status = ?, reviewer_user_id = ?, review_note = ?, reviewed_at = NOW() WHERE request_id = ?',
      [action === 'APPROVE' ? 'APPROVED' : 'REJECTED', actor.id, note, requestId]);
    await audit.record(tx, actor, action === 'APPROVE' ? 'ARTIST_NAME_CHANGE_APPROVED' : 'ARTIST_NAME_CHANGE_REJECTED', 'artist', r.artist_id,
      { name: r.old_name }, { name: r.new_name, note });
    if (r.requested_by) {
      await notify.notify(tx, r.requested_by, { kind: 'NAME_CHANGE', title: action === 'APPROVE' ? `Your artist name is now “${r.new_name}”` : 'Your artist name change was not approved',
        body: note, link: '/studio/profile' });
    }
    return { id: requestId, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  }, { actorId: actor.id });
}

// ---------------------------------------------------------------- suspension (Admin)
const SUSPEND_TAG = 'Artist suspended: ';

/**
 * Suspend: every account linked to the artist loses studio access to it, pending uploads freeze
 * (approval and publication check the account), and — if asked — published songs are suspended
 * from the catalogue. Reinstating restores exactly the songs this suspension removed.
 */
async function suspendArtist(actor, artistId, { reason, hideSongs = true }) {
  if (!String(reason || '').trim()) throw ApiError.badRequest('Give a reason for the suspension.');
  return withTransaction(async (tx) => {
    const a = await tx.one('SELECT artist_id, name FROM artists WHERE artist_id = ? FOR UPDATE', [artistId]);
    if (!a) throw ApiError.notFound('Artist');
    const accounts = await tx.query("SELECT user_id FROM artist_accounts WHERE artist_id = ? AND account_status = 'ACTIVE'", [artistId]);
    await tx.query(`UPDATE artist_accounts SET account_status = 'SUSPENDED', suspended_reason = ?, suspended_at = NOW(), suspended_by = ?
                     WHERE artist_id = ?`, [reason, actor.id, artistId]);
    let hidden = 0;
    if (hideSongs) {
      const r = await tx.query(`UPDATE songs SET status = 'HIDDEN', moderation_state = 'SUSPENDED', moderation_reason = ?, moderated_by = ?, moderated_at = NOW()
                                 WHERE primary_artist_id = ? AND status = 'ACTIVE' AND moderation_state = 'CLEAR'`, [`${SUSPEND_TAG}${reason}`.slice(0, 500), actor.id, artistId]);
      hidden = r.affectedRows;
    }
    await audit.record(tx, actor, 'ARTIST_SUSPENDED', 'artist', artistId, null, { reason, songs_hidden: hidden, accounts: accounts.length });
    for (const acc of accounts) {
      await notify.notify(tx, acc.user_id, { kind: 'ARTIST_SUSPENDED', title: `Your artist profile “${a.name}” was suspended`, body: reason, link: '/studio', email: true });
    }
    return { id: artistId, suspended: true, songsHidden: hidden };
  }, { actorId: actor.id });
}

async function reinstateArtist(actor, artistId, { note = null } = {}) {
  return withTransaction(async (tx) => {
    const a = await tx.one('SELECT artist_id, name FROM artists WHERE artist_id = ? FOR UPDATE', [artistId]);
    if (!a) throw ApiError.notFound('Artist');
    const accounts = await tx.query("SELECT aa.user_id FROM artist_accounts aa JOIN users u USING (user_id) WHERE aa.artist_id = ? AND aa.account_status = 'SUSPENDED' AND u.anonymised_at IS NULL", [artistId]);
    await tx.query(`UPDATE artist_accounts aa JOIN users u USING (user_id)
                       SET aa.account_status = 'ACTIVE', aa.suspended_reason = NULL, aa.suspended_at = NULL, aa.suspended_by = NULL
                     WHERE aa.artist_id = ? AND u.anonymised_at IS NULL`, [artistId]);
    const restored = await tx.query(`UPDATE songs SET moderation_state = 'CLEAR', moderation_reason = NULL, moderated_by = ?, moderated_at = NOW(),
                                            status = IF(EXISTS (SELECT 1 FROM audio_features af WHERE af.song_id = songs.song_id AND af.is_current = 1), 'ACTIVE', 'PENDING_ANALYSIS')
                                      WHERE primary_artist_id = ? AND moderation_state = 'SUSPENDED' AND moderation_reason LIKE ?`, [actor.id, artistId, `${SUSPEND_TAG}%`]);
    await audit.record(tx, actor, 'ARTIST_REINSTATED', 'artist', artistId, null, { note, songs_restored: restored.affectedRows });
    for (const acc of accounts) {
      await notify.notify(tx, acc.user_id, { kind: 'ARTIST_REINSTATED', title: `Your artist profile “${a.name}” is active again`, body: note, link: '/studio', email: true });
    }
    return { id: artistId, suspended: false, songsRestored: restored.affectedRows };
  }, { actorId: actor.id });
}

/** Plays, listeners and saves of the artist's songs (Studio → Listeners). */
async function stats(userId) {
  return query(
    `SELECT s.song_id AS id, s.title, s.status, s.moderation_state AS moderationState, a.name AS artist,
            (SELECT COUNT(*) FROM listening_history lh WHERE lh.song_id = s.song_id AND lh.started_at >= NOW() - INTERVAL 7 DAY) AS plays7d,
            (SELECT COUNT(*) FROM listening_history lh WHERE lh.song_id = s.song_id AND lh.started_at >= NOW() - INTERVAL 30 DAY) AS plays30d,
            (SELECT COUNT(DISTINCT lh.user_id) FROM listening_history lh WHERE lh.song_id = s.song_id AND lh.started_at >= NOW() - INTERVAL 30 DAY) AS listeners30d,
            (SELECT COUNT(*) FROM listening_history lh WHERE lh.song_id = s.song_id) AS playsAll,
            (SELECT COUNT(*) FROM user_likes ul WHERE ul.song_id = s.song_id) AS likes,
            (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.song_id = s.song_id) AS saves
       FROM songs s JOIN artists a ON a.artist_id = s.primary_artist_id
       JOIN artist_accounts aa ON aa.artist_id = s.primary_artist_id AND aa.user_id = ?
      ORDER BY plays30d DESC, s.title`, [userId]);
}

module.exports = {
  TERMS_VERSION, activeArtistAccount, myProfile, updateProfile, apply, withdrawApplication, listApplications, decideApplication,
  listNameChanges, decideNameChange, suspendArtist, reinstateArtist, stats,
};
