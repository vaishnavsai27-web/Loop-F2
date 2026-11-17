// Admin catalogue management: songs (metadata, sound profile, moods, explicit moderation states,
// audio), artists and albums. Every write runs in a transaction and is audited.
const { query, one, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const log = require('../utils/log');
const { toSong } = require('./songMapper');
const audit = require('./auditService');
const notify = require('./notifyService');
const { localMedia } = require('../providers');

/** Stable JSON (sorted keys) so equal payloads hash equally in source_records. */
function canonicalJson(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value));
}

async function activeModel(tx, kind) {
  const m = await tx.one('SELECT model_id FROM intelligence_models WHERE kind = ? AND is_active = 1', [kind]);
  if (!m) throw new ApiError(409, 'NO_ACTIVE_MODEL', `No active ${kind} model.`);
  return m.model_id;
}

/**
 * Store a sound profile as the song's current analysis and run the active mood model, so the song
 * gets mood tags. With activate=true a song waiting for analysis is published in the same step.
 */
async function storeAnalysis(tx, songId, f, { activate = true } = {}) {
  const featureModel = await activeModel(tx, 'AUDIO_FEATURES');
  const af = await tx.query(
    `INSERT INTO audio_features (song_id, model_id, energy, valence, danceability, acousticness, instrumentalness, speechiness,
                                 loudness_db, tempo_bpm, musical_key, mode, is_current)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [songId, featureModel, f.energy, f.valence, f.danceability, f.acousticness, f.instrumentalness, f.speechiness ?? 0.05,
      f.loudness_db ?? -8, f.tempo_bpm, f.key ?? 0, f.mode ?? 1]);
  await tx.call('sp_set_current_audio_features', [af.insertId]);
  await tx.call('sp_analyze_song_moods', [await activeModel(tx, 'MOOD'), null, songId]);
  if (activate) await tx.query("UPDATE songs SET status = 'ACTIVE' WHERE song_id = ? AND status = 'PENDING_ANALYSIS' AND moderation_state = 'CLEAR'", [songId]);
}

// ---------------------------------------------------------------- song states
/**
 * The state an Admin sees, derived from status + moderation_state:
 *   PUBLISHED, NEEDS_PROFILE (waiting for a sound profile), HIDDEN (editorial, can be unhidden),
 *   SUSPENDED (safety, restore with a reason), TAKEN_DOWN (rights), WITHDRAWN (by the artist — only
 *   a new upload brings it back), MERGED.
 */
function stateOf(status, moderation) {
  if (status === 'MERGED') return 'MERGED';
  if (moderation && moderation !== 'CLEAR') return moderation;
  if (status === 'ACTIVE') return 'PUBLISHED';
  if (status === 'PENDING_ANALYSIS') return 'NEEDS_PROFILE';
  return 'HIDDEN';
}

/** Which actions are allowed from each state (the server enforces this; the UI only shows them). */
const TRANSITIONS = {
  PUBLISHED: ['HIDE', 'SUSPEND', 'TAKE_DOWN'],
  NEEDS_PROFILE: ['HIDE', 'SUSPEND'],
  HIDDEN: ['UNHIDE', 'SUSPEND', 'TAKE_DOWN'],
  SUSPENDED: ['RESTORE', 'TAKE_DOWN'],
  TAKEN_DOWN: ['RESTORE'],
  WITHDRAWN: [],
  MERGED: [],
};

const SONG_FILTERS = {
  PUBLISHED: "s.status = 'ACTIVE'",
  NEEDS_PROFILE: "s.status = 'PENDING_ANALYSIS' AND s.moderation_state = 'CLEAR'",
  HIDDEN: "s.status = 'HIDDEN' AND s.moderation_state = 'CLEAR'",
  SUSPENDED: "s.moderation_state = 'SUSPENDED'",
  TAKEN_DOWN: "s.moderation_state = 'TAKEN_DOWN'",
  WITHDRAWN: "s.moderation_state = 'WITHDRAWN'",
  MERGED: "s.status = 'MERGED'",
};

async function listSongs({ q = '', state = null, artistId = null, albumId = null, genreId = null, playable = null, page = 1, pageSize = 25, sort = 'newest' }) {
  const where = ['1 = 1']; const params = [];
  if (state && SONG_FILTERS[state]) where.push(SONG_FILTERS[state]);
  if (q) {
    where.push('(sc.title LIKE ? OR sc.artist_name LIKE ? OR sc.album_title LIKE ? OR s.isrc = ? OR s.song_id = ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, q.toUpperCase(), /^\d+$/.test(q) ? Number(q) : 0);
  }
  if (artistId) { where.push('sc.artist_id = ?'); params.push(artistId); }
  if (albumId) { where.push('sc.album_id = ?'); params.push(albumId); }
  if (genreId) { where.push('sc.genre_id = ?'); params.push(genreId); }
  if (playable === 'yes') where.push('sc.playable = 1');
  if (playable === 'no') where.push('NOT sc.playable');
  const order = { newest: 's.song_id DESC', oldest: 's.song_id ASC', title: 'sc.title, s.song_id', artist: 'sc.artist_name, sc.title', popular: 'sc.popularity DESC, s.song_id' }[sort] || 's.song_id DESC';
  const from = 'FROM v_song_catalog sc JOIN songs s ON s.song_id = sc.song_id';
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const rows = await query(`SELECT sc.* ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, songs: rows.map((r) => ({ ...toSong(r), state: stateOf(r.status, r.moderation_state) })) };
}

async function songDetail(songId) {
  const row = await one('SELECT sc.*, s.moderation_reason, s.moderated_at, s.merged_into_song_id FROM v_song_catalog sc JOIN songs s ON s.song_id = sc.song_id WHERE sc.song_id = ?', [songId]);
  if (!row) throw ApiError.notFound('Song');
  const [moods, curations, media, uploads, stats, reports, history, credits] = await Promise.all([
    query('SELECT mood_id AS id, mood_name AS name, emoji, confidence FROM v_current_song_moods WHERE song_id = ? ORDER BY mood_rank', [songId]),
    query(`SELECT c.mood_id AS id, m.name, c.action, c.confidence, c.note, c.curated_at AS curatedAt, up.display_name AS curatedBy
             FROM song_mood_curations c JOIN moods m ON m.mood_id = c.mood_id LEFT JOIN user_profiles up ON up.user_id = c.curated_by
            WHERE c.song_id = ?`, [songId]),
    query(`SELECT sm.media_id AS id, ms.code AS source, sm.uri AS file, sm.rights_status AS rights, sm.availability, sm.attribution, sm.last_checked_at AS checkedAt
             FROM song_media sm JOIN music_sources ms ON ms.source_id = sm.source_id WHERE sm.song_id = ? AND sm.media_type = 'USER_LOCAL'`, [songId]),
    query(`SELECT upload_id AS id, status, source, created_at AS createdAt FROM artist_uploads WHERE song_id = ? OR target_song_id = ? ORDER BY created_at DESC`, [songId, songId]),
    one('SELECT plays, listeners, likes, avg_rating AS avgRating FROM v_song_stats WHERE song_id = ?', [songId]),
    query(`SELECT report_id AS id, reason, status, created_at AS createdAt FROM content_reports WHERE target_type = 'SONG' AND target_id = ? ORDER BY report_id DESC LIMIT 20`, [songId]),
    audit.forEntity('song', songId, 50),
    query('SELECT a.artist_id AS id, a.name, sa.role FROM song_artists sa JOIN artists a ON a.artist_id = sa.artist_id WHERE sa.song_id = ?', [songId]),
  ]);
  const state = stateOf(row.status, row.moderation_state);
  return {
    ...toSong(row), albumId: row.album_id, genreId: row.genre_id, languageId: row.language_id, trackNumber: row.track_number,
    description: row.description, state, moderationReason: row.moderation_reason, moderatedAt: row.moderated_at,
    mergedInto: row.merged_into_song_id, allowedActions: TRANSITIONS[state] || [], moodsDetailed: moods, curations, media, uploads,
    stats, reports, history, credits,
  };
}

const SONG_FIELDS = { title: 'title', versionLabel: 'version_label', albumId: 'album_id', trackNumber: 'track_number', durationSec: 'duration_sec',
  releaseYear: 'release_year', languageId: 'language_id', isrc: 'isrc', explicit: 'explicit', contentRating: 'content_rating',
  popularity: 'popularity', description: 'description', artistId: 'primary_artist_id' };

async function createSong(actor, s) {
  const { songId } = await withTransaction(async (tx) => {
    const src = await tx.one("SELECT source_id FROM music_sources WHERE code = 'MANUAL_ENTRY'");
    const artist = await tx.one('SELECT artist_id, name FROM artists WHERE artist_id = ?', [s.artistId]);
    if (!artist) throw ApiError.notFound('Artist');
    const contentRating = s.explicit && s.contentRating === 'ALL' ? 'TEEN' : s.contentRating;
    const r = await tx.query(
      `INSERT INTO songs (title, version_label, primary_artist_id, album_id, track_number, duration_sec, release_year, language_id,
                          isrc, explicit, content_rating, popularity, status, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ANALYSIS', ?)`,
      [s.title, s.versionLabel || '', s.artistId, s.albumId || null, s.trackNumber || null, s.durationSec, s.releaseYear,
        s.languageId || null, s.isrc || null, s.explicit ? 1 : 0, contentRating, s.popularity, s.description || null]);
    await tx.query('INSERT INTO song_genres (song_id, genre_id, is_primary) VALUES (?, ?, 1)', [r.insertId, s.genreId]);
    const payload = { title: s.title, artist: artist.name, duration_sec: s.durationSec, release_year: s.releaseYear, isrc: s.isrc || null,
      analysis: s.features ? { ...s.features, segments: [] } : undefined };
    const json = canonicalJson(payload);
    await tx.query(
      `INSERT INTO source_records (source_id, entity_type, external_id, isrc, song_id, rights_status, payload, payload_hash, status,
                                   match_method, match_confidence, quality_score, processing_version)
       VALUES (?, 'SONG', ?, ?, ?, 'PERMITTED', ?, SHA2(?, 256), 'COMPLETED', 'MANUAL', 1, 1, '2.0')`,
      [src.source_id, `manual:${r.insertId}`, s.isrc || null, r.insertId, json, json]);
    if (s.features) await storeAnalysis(tx, r.insertId, s.features, { activate: s.publish !== false });
    await audit.record(tx, actor, 'SONG_CREATED', 'song', r.insertId, null, { title: s.title, artist_id: s.artistId, analysed: !!s.features });
    return { songId: r.insertId };
  }, { actorId: actor.id });
  return songDetail(songId);
}

async function updateSong(actor, songId, patch) {
  await withTransaction(async (tx) => {
    const before = await tx.one('SELECT * FROM songs WHERE song_id = ? FOR UPDATE', [songId]);
    if (!before) throw ApiError.notFound('Song');
    if (before.status === 'MERGED') throw new ApiError(409, 'SONG_MERGED', 'A merged song cannot be edited; edit the song it was merged into.');
    if (patch.artistId && !(await tx.one('SELECT 1 AS ok FROM artists WHERE artist_id = ?', [patch.artistId]))) throw ApiError.notFound('Artist');
    if (patch.albumId && !(await tx.one('SELECT 1 AS ok FROM albums WHERE album_id = ?', [patch.albumId]))) throw ApiError.notFound('Album');
    const sets = []; const params = []; const changed = {};
    for (const [k, col] of Object.entries(SONG_FIELDS)) {
      if (patch[k] === undefined) continue;
      const v = k === 'explicit' ? (patch[k] ? 1 : 0) : (patch[k] === '' ? null : patch[k]);
      sets.push(`${col} = ?`); params.push(v); changed[k] = patch[k];
    }
    if (patch.explicit === true && patch.contentRating === undefined) sets.push("content_rating = IF(content_rating = 'ALL', 'TEEN', content_rating)");
    if (sets.length) await tx.query(`UPDATE songs SET ${sets.join(', ')} WHERE song_id = ?`, [...params, songId]);
    if (patch.genreId) {
      await tx.query('DELETE FROM song_genres WHERE song_id = ? AND is_primary = 1', [songId]);
      await tx.query('INSERT INTO song_genres (song_id, genre_id, is_primary) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE is_primary = 1', [songId, patch.genreId]);
      changed.genreId = patch.genreId;
    }
    if (patch.features) {
      await storeAnalysis(tx, songId, patch.features, { activate: false });
      changed.soundProfile = patch.features;
    }
    if (Object.keys(changed).length) {
      await audit.record(tx, actor, 'SONG_EDITED', 'song', songId,
        Object.fromEntries(Object.keys(changed).filter((k) => SONG_FIELDS[k]).map((k) => [k, before[SONG_FIELDS[k]]])), changed);
    }
  }, { actorId: actor.id });
  return songDetail(songId);
}

/** Explicit, audited state changes. A suspended/taken-down/withdrawn song never returns through "unhide". */
async function changeState(actor, songId, { action, reason = null }) {
  const needsReason = ['SUSPEND', 'TAKE_DOWN', 'RESTORE'];
  if (needsReason.includes(action) && !String(reason || '').trim()) throw ApiError.badRequest('Give a reason; it is shown in the song’s history.');
  const outcome = await withTransaction(async (tx) => {
    const s = await tx.one('SELECT song_id, title, status, moderation_state, primary_artist_id FROM songs WHERE song_id = ? FOR UPDATE', [songId]);
    if (!s) throw ApiError.notFound('Song');
    const state = stateOf(s.status, s.moderation_state);
    if (!(TRANSITIONS[state] || []).includes(action)) {
      const why = state === 'WITHDRAWN' ? 'The artist withdrew this recording; only a new upload from them can bring it back.'
        : `A ${state.toLowerCase().replace('_', ' ')} song cannot be changed with “${action.toLowerCase().replace('_', ' ')}”.`;
      throw new ApiError(409, 'INVALID_TRANSITION', why);
    }
    const hasProfile = await tx.one('SELECT 1 AS ok FROM audio_features WHERE song_id = ? AND is_current = 1', [songId]);
    const live = hasProfile ? 'ACTIVE' : 'PENDING_ANALYSIS';
    const upload = await tx.one("SELECT upload_id, user_id, media_id, status FROM artist_uploads WHERE song_id = ? AND source = 'ARTIST' ORDER BY created_at DESC LIMIT 1", [songId]);
    switch (action) {
      case 'HIDE':
        await tx.query("UPDATE songs SET status = 'HIDDEN' WHERE song_id = ?", [songId]); break;
      case 'UNHIDE':
        await tx.query('UPDATE songs SET status = ? WHERE song_id = ?', [live, songId]); break;
      case 'SUSPEND':
        await tx.query(`UPDATE songs SET status = IF(status = 'ACTIVE', 'HIDDEN', status), moderation_state = 'SUSPENDED', moderation_reason = ?,
                        moderated_by = ?, moderated_at = NOW() WHERE song_id = ?`, [reason, actor.id, songId]); break;
      case 'TAKE_DOWN':
        await tx.query(`UPDATE songs SET status = IF(status = 'ACTIVE', 'HIDDEN', status), moderation_state = 'TAKEN_DOWN', moderation_reason = ?,
                        moderated_by = ?, moderated_at = NOW() WHERE song_id = ?`, [reason, actor.id, songId]);
        await tx.query("UPDATE song_media SET rights_status = 'RESTRICTED', availability = 'UNAVAILABLE' WHERE song_id = ? AND media_type = 'USER_LOCAL'", [songId]);
        if (upload && upload.status === 'PUBLISHED') {
          await tx.query("UPDATE artist_uploads SET status = 'TAKEN_DOWN', review_note = ? WHERE upload_id = ?", [reason, upload.upload_id]);
          await tx.query(`INSERT INTO artist_upload_events (upload_id, actor_user_id, event_code, from_status, to_status, note) VALUES (?, ?, 'ADMIN_TAKEDOWN', 'PUBLISHED', 'TAKEN_DOWN', ?)`, [upload.upload_id, actor.id, reason]);
        }
        break;
      case 'RESTORE': {
        await tx.query(`UPDATE songs SET moderation_state = 'CLEAR', moderation_reason = NULL, moderated_by = ?, moderated_at = NOW(), status = ? WHERE song_id = ?`, [actor.id, live, songId]);
        if (s.moderation_state === 'TAKEN_DOWN') {
          const restored = await tx.query(`UPDATE song_media sm JOIN music_sources ms ON ms.source_id = sm.source_id
                                              SET sm.rights_status = 'PERMITTED', sm.availability = 'AVAILABLE'
                                            WHERE sm.song_id = ? AND sm.media_type = 'USER_LOCAL' AND sm.rights_status = 'RESTRICTED'`, [songId]);
          if (upload && upload.status === 'TAKEN_DOWN' && restored.affectedRows) {
            await tx.query("UPDATE artist_uploads SET status = 'PUBLISHED', review_note = ? WHERE upload_id = ?", [reason, upload.upload_id]);
            await tx.query(`INSERT INTO artist_upload_events (upload_id, actor_user_id, event_code, from_status, to_status, note) VALUES (?, ?, 'ADMIN_RESTORED', 'TAKEN_DOWN', 'PUBLISHED', ?)`, [upload.upload_id, actor.id, reason]);
          }
        }
        break;
      }
      default: throw ApiError.badRequest('Unknown action.');
    }
    await audit.record(tx, actor, `SONG_${action}`, 'song', songId, { state }, { reason });
    if (upload && ['SUSPEND', 'TAKE_DOWN', 'RESTORE'].includes(action)) {
      await notify.notify(tx, upload.user_id, { kind: 'SONG_MODERATED', email: true, link: '/studio/submissions',
        title: action === 'RESTORE' ? `“${s.title}” is back on LOOP` : `“${s.title}” was ${action === 'SUSPEND' ? 'suspended' : 'taken down'}`, body: reason });
    }
    return { state };
  }, { actorId: actor.id });
  // Taken-down files stay where they are (restricted in song_media) so a justified restore can re-enable
  // them; pipeline files never appear in the hand-registration list, so they cannot be re-attached by accident.
  return { ...(await songDetail(songId)), previousState: outcome.state };
}

/** Permanent deletion is allowed only for songs nobody has listened to; otherwise hide or take down. */
async function deleteSong(actor, songId) {
  return withTransaction(async (tx) => {
    const s = await tx.one(
      `SELECT s.song_id, s.title, s.status,
              (SELECT COUNT(*) FROM listening_history lh WHERE lh.song_id = s.song_id) AS plays,
              (SELECT COUNT(*) FROM artist_uploads au WHERE au.song_id = s.song_id) AS uploads,
              (SELECT COUNT(*) FROM songs m WHERE m.merged_into_song_id = s.song_id) AS merged_in
         FROM songs s WHERE s.song_id = ? FOR UPDATE`, [songId]);
    if (!s) throw ApiError.notFound('Song');
    if (s.plays > 0) throw new ApiError(409, 'SONG_HAS_HISTORY', `“${s.title}” has ${s.plays} plays in listeners’ history. Hide or take it down instead.`);
    if (s.uploads > 0) throw new ApiError(409, 'SONG_HAS_UPLOAD', `“${s.title}” came from an artist upload, which must stay on record. Take it down instead.`);
    if (s.merged_in > 0) throw new ApiError(409, 'SONG_IS_MERGE_TARGET', 'Other songs were merged into this one.');
    await tx.query('DELETE FROM source_records WHERE song_id = ?', [songId]);
    await tx.query('DELETE FROM songs WHERE song_id = ?', [songId]);   // audited by trg_songs_ad_audit
    await audit.record(tx, actor, 'SONG_DELETED_PERMANENTLY', 'song', songId, { title: s.title });
    return { songId, deleted: true, message: `“${s.title}” was deleted permanently.` };
  }, { actorId: actor.id });
}

/** Merge a duplicate into the song LOOP keeps: likes, ratings, playlist entries and dismissals move over. */
async function mergeSong(actor, songId, intoSongId) {
  if (songId === intoSongId) throw ApiError.badRequest('Choose a different song to keep.');
  return withTransaction(async (tx) => {
    const [a, b] = await Promise.all([
      tx.one('SELECT song_id, title, status FROM songs WHERE song_id = ? FOR UPDATE', [songId]),
      tx.one('SELECT song_id, title, status FROM songs WHERE song_id = ? FOR UPDATE', [intoSongId]),
    ]);
    if (!a || !b) throw ApiError.notFound('Song');
    if (a.status === 'MERGED' || b.status === 'MERGED') throw ApiError.conflict('ALREADY_MERGED', 'One of these songs is already merged.');
    await tx.query('UPDATE IGNORE user_likes SET song_id = ? WHERE song_id = ?', [intoSongId, songId]);
    await tx.query('UPDATE IGNORE ratings SET song_id = ? WHERE song_id = ?', [intoSongId, songId]);
    await tx.query('UPDATE IGNORE song_dismissals SET song_id = ? WHERE song_id = ?', [intoSongId, songId]);
    // rows that could not move (the listener already had the kept song) are duplicates; drop them
    await tx.query('DELETE FROM user_likes WHERE song_id = ?', [songId]);
    await tx.query('DELETE FROM ratings WHERE song_id = ?', [songId]);
    await tx.query('DELETE FROM song_dismissals WHERE song_id = ?', [songId]);
    const lists = await tx.query('SELECT playlist_id FROM playlist_songs WHERE song_id = ?', [songId]);
    for (const { playlist_id: p } of lists) {
      await tx.query('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', [p, songId]);
      await tx.query('INSERT IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)', [p, intoSongId]);
    }
    await tx.query("UPDATE song_media SET rights_status = 'RESTRICTED', availability = 'UNAVAILABLE' WHERE song_id = ?", [songId]);
    await tx.query("UPDATE songs SET status = 'MERGED', merged_into_song_id = ? WHERE song_id = ?", [intoSongId, songId]);
    await audit.record(tx, actor, 'SONG_MERGED', 'song', songId, { title: a.title }, { into: intoSongId, title: b.title, playlists: lists.length });
    return { songId, mergedInto: intoSongId };
  }, { actorId: actor.id });
}

async function curateMood(actor, songId, moodId, { action, confidence = null, note = null }) {
  if (action === 'ADD' && !confidence) throw ApiError.badRequest('Set how strongly the song has this mood.');
  await withTransaction(async (tx) => {
    if (!(await tx.one('SELECT 1 AS ok FROM songs WHERE song_id = ?', [songId]))) throw ApiError.notFound('Song');
    const m = await tx.one('SELECT mood_id, name FROM moods WHERE mood_id = ?', [moodId]);
    if (!m) throw new ApiError(400, 'INVALID_MOOD', 'Unknown mood.');
    const before = await tx.one('SELECT action, confidence FROM song_mood_curations WHERE song_id = ? AND mood_id = ?', [songId, moodId]);
    await tx.query(
      `INSERT INTO song_mood_curations (song_id, mood_id, action, confidence, note, curated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), confidence = VALUES(confidence), note = VALUES(note), curated_by = VALUES(curated_by)`,
      [songId, moodId, action, action === 'ADD' ? confidence : null, note, actor.id]);
    await audit.record(tx, actor, 'MOOD_CURATED', 'song', songId, before, { mood: m.name, action, confidence });
    if (await tx.one('SELECT 1 AS ok FROM audio_features WHERE song_id = ? AND is_current = 1', [songId])) {
      await tx.call('sp_analyze_song_moods', [await activeModel(tx, 'MOOD'), null, songId]);
    }
  }, { actorId: actor.id });
  return songDetail(songId);
}

async function clearCuration(actor, songId, moodId) {
  await withTransaction(async (tx) => {
    const r = await tx.query('DELETE FROM song_mood_curations WHERE song_id = ? AND mood_id = ?', [songId, moodId]);
    if (!r.affectedRows) throw ApiError.notFound('Mood decision');
    await audit.record(tx, actor, 'MOOD_CURATION_CLEARED', 'song', songId, { mood_id: moodId }, null);
    if (await tx.one('SELECT 1 AS ok FROM audio_features WHERE song_id = ? AND is_current = 1', [songId])) {
      await tx.call('sp_analyze_song_moods', [await activeModel(tx, 'MOOD'), null, songId]);
    }
  }, { actorId: actor.id });
  return songDetail(songId);
}

// ---------------------------------------------------------------- song audio
async function registerLibraryFile(actor, songId, { fileName, rights = 'PERMITTED', attribution = null }) {
  if (!localMedia.writable()) throw new ApiError(503, 'UPLOAD_STORAGE_UNAVAILABLE', 'LOOP’s audio storage is not on a persistent volume, so recordings cannot be added here.');
  if (localMedia.MANAGED.test(fileName)) throw new ApiError(400, 'MANAGED_FILE', 'Files from the upload pipeline cannot be registered by hand.');
  const file = localMedia.resolveFile(fileName);
  if (!file || !localMedia.available(fileName)) throw new ApiError(400, 'LOCAL_FILE_NOT_FOUND', 'Choose an audio file that is in LOOP’s media library.');
  if (rights === 'ATTRIBUTION_REQUIRED' && !String(attribution || '').trim()) throw ApiError.badRequest('Attribution is required for this recording.');
  return withTransaction(async (tx) => {
    const s = await tx.one('SELECT song_id, moderation_state FROM songs WHERE song_id = ?', [songId]);
    if (!s) throw ApiError.notFound('Song');
    if (s.moderation_state !== 'CLEAR') throw ApiError.conflict('SONG_MODERATED', 'Restore the song before giving it audio.');
    const src = await tx.one("SELECT source_id FROM music_sources WHERE code = 'LOCAL_MEDIA' AND is_enabled = 1");
    if (!src) throw new ApiError(503, 'LOCAL_MEDIA_DISABLED', 'The LOOP media source is disabled.');
    await tx.query(
      `INSERT INTO song_media (song_id, source_id, media_type, uri, rights_status, availability, last_checked_at, attribution, priority)
       VALUES (?, ?, 'USER_LOCAL', ?, ?, 'AVAILABLE', NOW(), ?, 5)
       ON DUPLICATE KEY UPDATE uri = VALUES(uri), rights_status = VALUES(rights_status), availability = 'AVAILABLE', last_checked_at = NOW(), attribution = VALUES(attribution)`,
      [songId, src.source_id, fileName, rights, attribution || null]);
    await audit.record(tx, actor, 'MEDIA_REGISTERED', 'song', songId, null, { file: fileName, rights });
    return { songId, fileName, rights };
  }, { actorId: actor.id });
}

/** Detach audio from a song (the file is kept privately; the song becomes "not available to play"). */
async function removeMedia(actor, songId, mediaId) {
  const m = await withTransaction(async (tx) => {
    const row = await tx.one("SELECT media_id, uri FROM song_media WHERE media_id = ? AND song_id = ? AND media_type = 'USER_LOCAL' FOR UPDATE", [mediaId, songId]);
    if (!row) throw ApiError.notFound('Recording');
    await tx.query("UPDATE song_media SET rights_status = 'RESTRICTED', availability = 'UNAVAILABLE' WHERE media_id = ?", [mediaId]);
    await audit.record(tx, actor, 'MEDIA_REMOVED', 'song', songId, { file: row.uri }, null);
    return row;
  }, { actorId: actor.id });
  if (localMedia.writable()) await localMedia.retain(m.uri).catch((err) => log.warn('removed media file could not be moved to retained/', { file: m.uri, code: err.code || err.message }));
  return songDetail(songId);
}

async function previewMedia(mediaId) {
  const row = await one("SELECT uri FROM song_media WHERE media_id = ? AND media_type = 'USER_LOCAL'", [mediaId]);
  const f = row && localMedia.resolveFile(row.uri);
  if (!f || !localMedia.available(row.uri)) throw new ApiError(404, 'MEDIA_MISSING', 'This recording’s file is not in storage.');
  return f;
}

async function mediaLibrary() {
  // eslint-disable-next-line global-require
  const media = require('./mediaService');
  return { summary: await media.summary(), storage: localMedia.check(), localFiles: localMedia.list(),
    missing: await query(`SELECT sm.media_id AS id, sm.song_id AS songId, s.title, sm.uri AS file FROM song_media sm JOIN songs s USING (song_id)
                           WHERE sm.media_type = 'USER_LOCAL' AND sm.availability = 'UNAVAILABLE' AND sm.rights_status <> 'RESTRICTED' LIMIT 50`) };
}

// ---------------------------------------------------------------- artists
async function listArtists({ q = '', status = null, page = 1, pageSize = 25 }) {
  const where = ['1 = 1']; const params = [];
  if (q) { where.push('(a.name LIKE ? OR EXISTS (SELECT 1 FROM artist_aliases al WHERE al.artist_id = a.artist_id AND al.alias LIKE ?) OR a.artist_id = ?)'); params.push(`%${q}%`, `%${q}%`, /^\d+$/.test(q) ? Number(q) : 0); }
  if (status === 'linked') where.push("EXISTS (SELECT 1 FROM artist_accounts x WHERE x.artist_id = a.artist_id AND x.account_status = 'ACTIVE')");
  if (status === 'suspended') where.push("EXISTS (SELECT 1 FROM artist_accounts x WHERE x.artist_id = a.artist_id AND x.account_status = 'SUSPENDED')");
  if (status === 'catalogue') where.push('NOT EXISTS (SELECT 1 FROM artist_accounts x WHERE x.artist_id = a.artist_id)');
  if (status === 'duplicates') where.push('(SELECT COUNT(*) FROM artists d WHERE LOWER(d.name) = LOWER(a.name)) > 1');
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM artists a WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT a.artist_id AS id, a.name, a.disambiguation, a.artist_type AS type, a.country_code AS country, a.formed_year AS formedYear,
            (SELECT COUNT(*) FROM songs s WHERE s.primary_artist_id = a.artist_id) AS songs,
            (SELECT COUNT(*) FROM songs s WHERE s.primary_artist_id = a.artist_id AND s.status = 'ACTIVE') AS publishedSongs,
            (SELECT GROUP_CONCAT(x.account_status) FROM artist_accounts x WHERE x.artist_id = a.artist_id) AS accounts,
            (SELECT COUNT(*) FROM artist_name_changes nc WHERE nc.artist_id = a.artist_id AND nc.status = 'PENDING') AS pendingNameChanges
       FROM artists a WHERE ${where.join(' AND ')} ORDER BY a.name LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, artists: rows.map((r) => ({ ...r, status: !r.accounts ? 'CATALOGUE' : r.accounts.includes('ACTIVE') ? 'ACTIVE' : 'SUSPENDED' })) };
}

async function artistDetail(artistId) {
  const a = await one(`SELECT a.artist_id AS id, a.name, a.disambiguation, a.artist_type AS type, a.country_code AS countryCode, a.region_code AS regionCode,
                              a.primary_language_id AS languageId, a.formed_year AS formedYear, a.bio, a.created_at AS createdAt
                         FROM artists a WHERE a.artist_id = ?`, [artistId]);
  if (!a) throw ApiError.notFound('Artist');
  const [aliases, accounts, songs, albums, uploads, nameChanges, applications, reports, history, sameName] = await Promise.all([
    query('SELECT alias, alias_type AS type FROM artist_aliases WHERE artist_id = ? ORDER BY alias', [artistId]),
    query(`SELECT aa.user_id AS userId, u.username, u.is_active AS userActive, aa.account_status AS status, aa.suspended_reason AS suspendedReason,
                  aa.suspended_at AS suspendedAt, aa.created_at AS linkedAt FROM artist_accounts aa JOIN users u USING (user_id) WHERE aa.artist_id = ?`, [artistId]),
    query(`SELECT s.song_id AS id, s.title, s.status, s.moderation_state AS moderationState, s.release_year AS releaseYear FROM songs s
            WHERE s.primary_artist_id = ? ORDER BY s.release_year DESC, s.title LIMIT 200`, [artistId]),
    query(`SELECT al.album_id AS id, al.title, al.album_type AS type, al.release_year AS releaseYear, al.status FROM albums al
             JOIN album_artists aa ON aa.album_id = al.album_id WHERE aa.artist_id = ? ORDER BY al.release_year DESC`, [artistId]),
    query('SELECT upload_id AS id, title, status, source, created_at AS createdAt FROM artist_uploads WHERE artist_id = ? ORDER BY created_at DESC LIMIT 50', [artistId]),
    query(`SELECT request_id AS id, old_name AS oldName, new_name AS newName, reason, status, review_note AS reviewNote, created_at AS createdAt
             FROM artist_name_changes WHERE artist_id = ? ORDER BY request_id DESC`, [artistId]),
    query('SELECT application_id AS id, stage_name AS stageName, status, submitted_at AS submittedAt FROM artist_applications WHERE artist_id = ?', [artistId]),
    query(`SELECT report_id AS id, reason, status, created_at AS createdAt FROM content_reports WHERE target_type = 'ARTIST' AND target_id = ? ORDER BY report_id DESC LIMIT 20`, [artistId]),
    audit.forEntity('artist', artistId, 50),
    query('SELECT artist_id AS id, name, disambiguation FROM artists WHERE LOWER(name) = LOWER(?) AND artist_id <> ?', [a.name, artistId]),
  ]);
  const status = !accounts.length ? 'CATALOGUE' : accounts.some((x) => x.status === 'ACTIVE') ? 'ACTIVE' : 'SUSPENDED';
  return { ...a, status, aliases, accounts: accounts.map((x) => ({ ...x, userActive: !!x.userActive })), songs, albums, uploads, nameChanges, applications, reports, history, sameName };
}

async function createArtist(actor, a) {
  return withTransaction(async (tx) => {
    const r = await tx.query(
      `INSERT INTO artists (name, disambiguation, artist_type, country_code, region_code, primary_language_id, formed_year, bio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.name, a.disambiguation || '', a.type, a.countryCode, a.regionCode || null, a.languageId || null, a.formedYear || null, a.bio || null]);
    for (const alias of a.aliases || []) await tx.query("INSERT INTO artist_aliases (artist_id, alias, alias_type) VALUES (?, ?, 'SPELLING')", [r.insertId, alias]);
    await audit.record(tx, actor, 'ARTIST_CREATED', 'artist', r.insertId, null, { name: a.name });
    return { id: r.insertId, name: a.name };
  }, { actorId: actor.id });
}

async function updateArtist(actor, artistId, a) {
  await withTransaction(async (tx) => {
    const before = await tx.one('SELECT name, disambiguation, artist_type, country_code, region_code, primary_language_id, formed_year, bio FROM artists WHERE artist_id = ? FOR UPDATE', [artistId]);
    if (!before) throw ApiError.notFound('Artist');
    const map = { name: 'name', disambiguation: 'disambiguation', type: 'artist_type', countryCode: 'country_code', regionCode: 'region_code',
      languageId: 'primary_language_id', formedYear: 'formed_year', bio: 'bio' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) if (a[k] !== undefined) { sets.push(`${col} = ?`); params.push(a[k] === '' && col !== 'disambiguation' ? null : a[k]); }
    if (!sets.length) throw ApiError.badRequest('Nothing to change.');
    await tx.query(`UPDATE artists SET ${sets.join(', ')} WHERE artist_id = ?`, [...params, artistId]);
    if (a.name !== undefined && a.name !== before.name) await tx.query("UPDATE artist_name_changes SET status = 'CANCELLED' WHERE artist_id = ? AND status = 'PENDING'", [artistId]);
    await audit.record(tx, actor, 'ARTIST_UPDATED', 'artist', artistId, before, a);
  }, { actorId: actor.id });
  return artistDetail(artistId);
}

async function setAliases(actor, artistId, aliases) {
  await withTransaction(async (tx) => {
    if (!(await tx.one('SELECT 1 AS ok FROM artists WHERE artist_id = ?', [artistId]))) throw ApiError.notFound('Artist');
    const before = await tx.query('SELECT alias FROM artist_aliases WHERE artist_id = ?', [artistId]);
    await tx.query('DELETE FROM artist_aliases WHERE artist_id = ?', [artistId]);
    for (const alias of [...new Set(aliases.map((x) => x.trim()).filter(Boolean))]) {
      await tx.query("INSERT INTO artist_aliases (artist_id, alias, alias_type) VALUES (?, ?, 'SPELLING')", [artistId, alias]);
    }
    await audit.record(tx, actor, 'ARTIST_ALIASES_CHANGED', 'artist', artistId, { aliases: before.map((x) => x.alias) }, { aliases });
  }, { actorId: actor.id });
  return artistDetail(artistId);
}

// ---------------------------------------------------------------- albums
async function listAlbums({ q = '', status = null, artistId = null, page = 1, pageSize = 25 }) {
  const where = ['1 = 1']; const params = [];
  if (q) { where.push('(al.title LIKE ? OR al.album_id = ?)'); params.push(`%${q}%`, /^\d+$/.test(q) ? Number(q) : 0); }
  if (status) { where.push('al.status = ?'); params.push(status); }
  if (artistId) { where.push('EXISTS (SELECT 1 FROM album_artists x WHERE x.album_id = al.album_id AND x.artist_id = ?)'); params.push(artistId); }
  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM albums al WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT al.album_id AS id, al.title, al.album_type AS type, al.release_year AS releaseYear, al.status, al.artwork_file AS artworkFile,
            al.cover_color_1 AS c1, al.cover_color_2 AS c2,
            (SELECT GROUP_CONCAT(a.name ORDER BY aa.credit_order SEPARATOR ', ') FROM album_artists aa JOIN artists a USING (artist_id) WHERE aa.album_id = al.album_id) AS artists,
            (SELECT COUNT(*) FROM songs s WHERE s.album_id = al.album_id) AS tracks
       FROM albums al WHERE ${where.join(' AND ')} ORDER BY al.album_id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, albums: rows.map((r) => ({ ...r, artworkUrl: r.artworkFile ? `/api/artwork/${r.artworkFile}` : null })) };
}

async function albumDetail(albumId) {
  const a = await one(`SELECT album_id AS id, title, album_type AS type, release_year AS releaseYear, language_id AS languageId, status, description,
                              cover_color_1 AS coverColor1, cover_color_2 AS coverColor2, artwork_file AS artworkFile FROM albums WHERE album_id = ?`, [albumId]);
  if (!a) throw ApiError.notFound('Album');
  const [artists, tracks, history] = await Promise.all([
    query('SELECT a.artist_id AS id, a.name FROM album_artists aa JOIN artists a USING (artist_id) WHERE aa.album_id = ? ORDER BY aa.credit_order', [albumId]),
    query(`SELECT s.song_id AS id, s.title, s.track_number AS trackNumber, s.status, s.moderation_state AS moderationState, s.duration_sec AS durationSec
             FROM songs s WHERE s.album_id = ? ORDER BY s.track_number IS NULL, s.track_number, s.song_id`, [albumId]),
    audit.forEntity('album', albumId, 30),
  ]);
  return { ...a, artworkUrl: a.artworkFile ? `/api/artwork/${a.artworkFile}` : null, artists, tracks, history };
}

async function createAlbum(actor, a) {
  const id = await withTransaction(async (tx) => {
    const r = await tx.query(
      `INSERT INTO albums (title, album_type, release_year, language_id, cover_color_1, cover_color_2, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.title, a.albumType, a.releaseYear, a.languageId || null, a.coverColor1, a.coverColor2, a.description || null, a.status || 'PUBLISHED']);
    for (const [i, artistId] of a.artistIds.entries()) await tx.query('INSERT INTO album_artists (album_id, artist_id, credit_order) VALUES (?, ?, ?)', [r.insertId, artistId, i + 1]);
    await audit.record(tx, actor, 'ALBUM_CREATED', 'album', r.insertId, null, { title: a.title, artists: a.artistIds });
    return r.insertId;
  }, { actorId: actor.id });
  return albumDetail(id);
}

async function updateAlbum(actor, albumId, a) {
  await withTransaction(async (tx) => {
    const before = await tx.one('SELECT title, album_type, release_year, language_id, status, description, cover_color_1, cover_color_2 FROM albums WHERE album_id = ? FOR UPDATE', [albumId]);
    if (!before) throw ApiError.notFound('Album');
    const map = { title: 'title', albumType: 'album_type', releaseYear: 'release_year', languageId: 'language_id', status: 'status',
      description: 'description', coverColor1: 'cover_color_1', coverColor2: 'cover_color_2' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) if (a[k] !== undefined) { sets.push(`${col} = ?`); params.push(a[k] === '' ? null : a[k]); }
    if (sets.length) await tx.query(`UPDATE albums SET ${sets.join(', ')} WHERE album_id = ?`, [...params, albumId]);
    if (a.artistIds) {
      await tx.query('DELETE FROM album_artists WHERE album_id = ?', [albumId]);
      for (const [i, artistId] of a.artistIds.entries()) await tx.query('INSERT INTO album_artists (album_id, artist_id, credit_order) VALUES (?, ?, ?)', [albumId, artistId, i + 1]);
    }
    await audit.record(tx, actor, a.status && a.status !== before.status ? `ALBUM_${a.status}` : 'ALBUM_UPDATED', 'album', albumId, before, a);
  }, { actorId: actor.id });
  return albumDetail(albumId);
}

/** Set the album's track list in order (adds new songs, removes songs left out). */
async function setTracks(actor, albumId, songIds) {
  await withTransaction(async (tx) => {
    if (!(await tx.one('SELECT 1 AS ok FROM albums WHERE album_id = ? FOR UPDATE', [albumId]))) throw ApiError.notFound('Album');
    const unique = [...new Set(songIds)];
    if (unique.length !== songIds.length) throw ApiError.badRequest('A song appears twice in the track list.');
    if (unique.length) {
      const found = await tx.query('SELECT song_id FROM songs WHERE song_id IN (?)', [unique]);
      if (found.length !== unique.length) throw ApiError.notFound('One of the songs');
    }
    const before = await tx.query('SELECT song_id FROM songs WHERE album_id = ? ORDER BY track_number', [albumId]);
    await tx.query('UPDATE songs SET album_id = NULL, track_number = NULL WHERE album_id = ?' + (unique.length ? ' AND song_id NOT IN (?)' : ''), unique.length ? [albumId, unique] : [albumId]);
    for (const [i, songId] of unique.entries()) await tx.query('UPDATE songs SET album_id = ?, track_number = ? WHERE song_id = ?', [albumId, Math.min(i + 1, 255), songId]);
    await audit.record(tx, actor, 'ALBUM_TRACKS_CHANGED', 'album', albumId, { songs: before.map((x) => x.song_id) }, { songs: unique });
  }, { actorId: actor.id });
  return albumDetail(albumId);
}

/** Delete an empty album; an album with tracks is unpublished instead (its songs keep their history). */
async function deleteAlbum(actor, albumId) {
  return withTransaction(async (tx) => {
    const a = await tx.one('SELECT title, (SELECT COUNT(*) FROM songs s WHERE s.album_id = albums.album_id) AS tracks, (SELECT COUNT(*) FROM source_records sr WHERE sr.album_id = albums.album_id) AS provenance FROM albums WHERE album_id = ? FOR UPDATE', [albumId]);
    if (!a) throw ApiError.notFound('Album');
    if (a.tracks > 0) throw new ApiError(409, 'ALBUM_HAS_TRACKS', `“${a.title}” still has ${a.tracks} tracks. Remove them first, or unpublish the album.`);
    if (a.provenance > 0) await tx.query('DELETE FROM source_records WHERE album_id = ?', [albumId]);
    await tx.query('DELETE FROM albums WHERE album_id = ?', [albumId]);
    await audit.record(tx, actor, 'ALBUM_DELETED', 'album', albumId, { title: a.title });
    return { id: albumId, deleted: true };
  }, { actorId: actor.id });
}

async function setArtwork(actor, kind, id, fileName) {
  const table = kind === 'album' ? 'albums' : 'songs';
  const key = kind === 'album' ? 'album_id' : 'song_id';
  const r = await query(`UPDATE ${table} SET artwork_file = ? WHERE ${key} = ?`, [fileName, id]);
  if (!r.affectedRows) throw ApiError.notFound(kind === 'album' ? 'Album' : 'Song');
  await audit.record(null, actor, 'ARTWORK_CHANGED', kind, id, null, { file: fileName });
  return { id, artworkUrl: fileName ? `/api/artwork/${fileName}` : null };
}

module.exports = {
  storeAnalysis, stateOf, TRANSITIONS, listSongs, songDetail, createSong, updateSong, changeState, deleteSong, mergeSong,
  curateMood, clearCuration, registerLibraryFile, removeMedia, previewMedia, mediaLibrary,
  listArtists, artistDetail, createArtist, updateArtist, setAliases,
  listAlbums, albumDetail, createAlbum, updateAlbum, setTracks, deleteAlbum, setArtwork,
};
