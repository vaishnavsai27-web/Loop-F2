// Admin overview, navigation badges, taxonomy (moods, mood vocabulary, genres, languages, contexts),
// recommender weights, editorial picks and duplicate detection.
const { query, one, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const audit = require('./auditService');
const moodParser = require('./moodParser');
const { localMedia } = require('../providers');

async function overview() {
  const [counts, registrations, uploads, activity, health] = await Promise.all([
    one(`SELECT
        (SELECT COUNT(*) FROM users WHERE anonymised_at IS NULL) AS users_total,
        (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users_active,
        (SELECT COUNT(DISTINCT user_id) FROM listening_history WHERE started_at >= NOW() - INTERVAL 30 DAY) AS listeners_30d,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL 7 DAY) AS registrations_7d,
        (SELECT COUNT(*) FROM artists) AS artists_total,
        (SELECT COUNT(DISTINCT artist_id) FROM artist_accounts WHERE account_status = 'ACTIVE') AS artists_linked,
        (SELECT COUNT(DISTINCT artist_id) FROM artist_accounts WHERE account_status = 'SUSPENDED') AS artists_suspended,
        (SELECT COUNT(*) FROM artist_applications WHERE status = 'PENDING') AS applications_pending,
        (SELECT COUNT(*) FROM artist_name_changes WHERE status = 'PENDING') AS name_changes_pending,
        (SELECT COUNT(*) FROM songs WHERE status = 'ACTIVE') AS songs_published,
        (SELECT COUNT(*) FROM songs WHERE status = 'PENDING_ANALYSIS' AND moderation_state = 'CLEAR') AS songs_need_profile,
        (SELECT COUNT(*) FROM songs WHERE status = 'HIDDEN' AND moderation_state = 'CLEAR') AS songs_hidden,
        (SELECT COUNT(*) FROM songs WHERE moderation_state IN ('SUSPENDED','TAKEN_DOWN')) AS songs_moderated,
        (SELECT COUNT(*) FROM v_song_playback p JOIN songs s ON s.song_id = p.song_id AND s.status = 'ACTIVE') AS songs_playable,
        (SELECT COUNT(*) FROM albums) AS albums_total,
        (SELECT COUNT(*) FROM artist_uploads WHERE status = 'PENDING_REVIEW') AS uploads_to_review,
        (SELECT COUNT(*) FROM artist_uploads WHERE status = 'APPROVED') AS uploads_to_publish,
        (SELECT COUNT(*) FROM artist_uploads WHERE status IN ('QUARANTINED','PROCESSING')) AS uploads_in_quarantine,
        (SELECT MIN(created_at) FROM artist_uploads WHERE status IN ('QUARANTINED','PROCESSING')) AS oldest_quarantine,
        (SELECT COUNT(*) FROM artist_uploads WHERE status = 'REJECTED' AND updated_at >= NOW() - INTERVAL 30 DAY) AS uploads_rejected_30d,
        (SELECT COUNT(*) FROM content_reports WHERE status IN ('OPEN','UNDER_REVIEW')) AS reports_open,
        (SELECT MIN(created_at) FROM content_reports WHERE status = 'OPEN') AS oldest_report,
        (SELECT COUNT(*) FROM listening_history) AS plays_total,
        (SELECT COUNT(*) FROM listening_history WHERE started_at >= NOW() - INTERVAL 7 DAY) AS plays_7d,
        (SELECT COUNT(*) FROM recommendation_batches WHERE created_at >= NOW() - INTERVAL 7 DAY) AS mood_requests_7d,
        (SELECT COUNT(*) FROM song_media sm WHERE sm.media_type = 'USER_LOCAL' AND sm.availability = 'UNAVAILABLE' AND sm.rights_status <> 'RESTRICTED') AS audio_missing,
        (SELECT COUNT(*) FROM pipeline_jobs WHERE status = 'FAILED' AND completed_at >= NOW() - INTERVAL 7 DAY) AS jobs_failed_7d`),
    query(`SELECT u.user_id AS id, u.username, p.display_name AS displayName, u.created_at AS createdAt
             FROM users u JOIN user_profiles p USING (user_id) WHERE u.anonymised_at IS NULL ORDER BY u.user_id DESC LIMIT 6`),
    query(`SELECT au.upload_id AS id, au.title, a.name AS artistName, au.status, au.source, au.created_at AS createdAt
             FROM artist_uploads au JOIN artists a USING (artist_id) ORDER BY au.created_at DESC LIMIT 6`),
    query(`SELECT a.audit_id AS id, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.created_at AS createdAt,
                  COALESCE(a.actor_label, 'system') AS actor
             FROM audit_logs a JOIN users u ON u.user_id = a.actor_user_id JOIN roles r ON r.role_id = u.role_id
            WHERE r.code = 'ADMIN' ORDER BY a.audit_id DESC LIMIT 8`),
    systemHealth(),
  ]);
  return { counts, recentRegistrations: registrations, recentUploads: uploads, recentAdminActivity: activity, health };
}

async function systemHealth() {
  // eslint-disable-next-line global-require
  const uploads = require('./uploadService');
  const [scanner, readiness] = await Promise.all([uploads.scannerStatus(), one('SELECT MAX(version) AS v FROM schema_migrations')]);
  return { database: 'up', schema: readiness.v, storage: localMedia.check(), scanner };
}

/** Counts shown as badges in the Admin navigation. */
async function badges() {
  return one(`SELECT
      (SELECT COUNT(*) FROM artist_applications WHERE status = 'PENDING') AS applications,
      (SELECT COUNT(*) FROM artist_uploads WHERE status IN ('PENDING_REVIEW','APPROVED')) AS uploads,
      (SELECT COUNT(*) FROM content_reports WHERE status IN ('OPEN','UNDER_REVIEW')) AS reports,
      (SELECT COUNT(*) FROM artist_name_changes WHERE status = 'PENDING') AS artists`);
}

async function references() {
  const [artists, albums, genres, languages, moods, contexts, regions] = await Promise.all([
    query('SELECT artist_id AS id, name, disambiguation FROM artists ORDER BY name'),
    query(`SELECT al.album_id AS id, al.title, al.album_type AS type, a.name AS artist FROM albums al
             LEFT JOIN album_artists aa ON aa.album_id = al.album_id AND aa.credit_order = 1 LEFT JOIN artists a ON a.artist_id = aa.artist_id ORDER BY al.title`),
    query('SELECT genre_id AS id, name, parent_genre_id AS parentId, color_hex AS color FROM genres ORDER BY name'),
    query('SELECT language_id AS id, name, iso_code AS iso FROM languages ORDER BY name'),
    query('SELECT mood_id AS id, name, emoji, color_hex AS color FROM moods ORDER BY name'),
    query('SELECT code, name FROM contexts ORDER BY sort_order'),
    query("SELECT region_code AS code, name FROM regions ORDER BY country_code = 'XX', name"),
  ]);
  return { artists, albums, genres, languages, moods, contexts, regions };
}

// ---------------------------------------------------------------- taxonomy
async function taxonomy() {
  const [moods, keywords, genres, languages, contexts, contextKeywords, categories] = await Promise.all([
    query(`SELECT m.mood_id AS id, m.name, m.emoji, m.color_hex AS color, m.description, m.category_id AS categoryId,
                  m.target_energy AS energy, m.target_valence AS valence, m.target_danceability AS danceability, m.target_acousticness AS acousticness,
                  m.target_instrumentalness AS instrumentalness, m.tempo_min AS tempoMin, m.tempo_max AS tempoMax,
                  (SELECT COUNT(*) FROM v_current_song_moods cm WHERE cm.mood_id = m.mood_id AND cm.confidence >= 0.5) AS songs
             FROM moods m ORDER BY m.category_id, m.mood_id`),
    query('SELECT keyword_id AS id, phrase, mood_id AS moodId, weight FROM mood_keywords ORDER BY phrase'),
    query(`SELECT g.genre_id AS id, g.name, g.parent_genre_id AS parentId, g.color_hex AS color, g.description,
                  (SELECT COUNT(*) FROM song_genres sg WHERE sg.genre_id = g.genre_id) AS songs FROM genres g ORDER BY g.name`),
    query(`SELECT l.language_id AS id, l.iso_code AS iso, l.name, l.native_name AS nativeName, l.script,
                  (SELECT COUNT(*) FROM songs s WHERE s.language_id = l.language_id) AS songs FROM languages l ORDER BY l.name`),
    query('SELECT context_id AS id, code, name, emoji, description, sort_order AS sortOrder FROM contexts ORDER BY sort_order'),
    query('SELECT phrase, context_id AS contextId FROM context_keywords ORDER BY phrase'),
    query('SELECT category_id AS id, name FROM mood_categories ORDER BY category_id'),
  ]);
  return { moods, keywords, genres, languages, contexts, contextKeywords, categories };
}

async function updateMood(actor, moodId, m) {
  await withTransaction(async (tx) => {
    const before = await tx.one('SELECT * FROM moods WHERE mood_id = ? FOR UPDATE', [moodId]);
    if (!before) throw ApiError.notFound('Mood');
    const map = { name: 'name', emoji: 'emoji', color: 'color_hex', description: 'description', energy: 'target_energy', valence: 'target_valence',
      danceability: 'target_danceability', acousticness: 'target_acousticness', instrumentalness: 'target_instrumentalness', tempoMin: 'tempo_min', tempoMax: 'tempo_max' };
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(map)) if (m[k] !== undefined) { sets.push(`${col} = ?`); params.push(m[k]); }
    if (!sets.length) throw ApiError.badRequest('Nothing to change.');
    if ((m.tempoMin ?? before.tempo_min) >= (m.tempoMax ?? before.tempo_max)) throw ApiError.badRequest('The slowest tempo must be below the fastest.');
    await tx.query(`UPDATE moods SET ${sets.join(', ')} WHERE mood_id = ?`, [...params, moodId]);
    await audit.record(tx, actor, 'MOOD_UPDATED', 'mood', moodId, { name: before.name }, m);
  }, { actorId: actor.id });
  moodParser.invalidate();
  return taxonomy();
}

async function addKeyword(actor, { phrase, moodId, weight }) {
  const norm = moodParser.normalise(phrase);
  if (norm.length < 2) throw ApiError.badRequest('Enter a word or phrase.');
  await withTransaction(async (tx) => {
    if (!(await tx.one('SELECT 1 AS ok FROM moods WHERE mood_id = ?', [moodId]))) throw ApiError.notFound('Mood');
    const dup = await tx.one('SELECT keyword_id FROM mood_keywords WHERE phrase = ? AND mood_id = ?', [norm, moodId]);
    if (dup) throw ApiError.conflict('DUPLICATE_PHRASE', 'That phrase is already linked to this mood.');
    const r = await tx.query('INSERT INTO mood_keywords (phrase, mood_id, weight) VALUES (?, ?, ?)', [norm, moodId, weight]);
    await audit.record(tx, actor, 'MOOD_PHRASE_ADDED', 'mood', moodId, null, { phrase: norm, weight, id: r.insertId });
  }, { actorId: actor.id });
  moodParser.invalidate();
  return taxonomy();
}

async function removeKeyword(actor, keywordId) {
  await withTransaction(async (tx) => {
    const k = await tx.one('SELECT phrase, mood_id FROM mood_keywords WHERE keyword_id = ?', [keywordId]);
    if (!k) throw ApiError.notFound('Phrase');
    await tx.query('DELETE FROM mood_keywords WHERE keyword_id = ?', [keywordId]);
    await audit.record(tx, actor, 'MOOD_PHRASE_REMOVED', 'mood', k.mood_id, { phrase: k.phrase });
  }, { actorId: actor.id });
  moodParser.invalidate();
  return taxonomy();
}

async function saveGenre(actor, genreId, g) {
  await withTransaction(async (tx) => {
    if (g.parentId && g.parentId === genreId) throw ApiError.badRequest('A genre cannot be its own parent.');
    if (genreId) {
      const before = await tx.one('SELECT name, parent_genre_id, color_hex, description FROM genres WHERE genre_id = ? FOR UPDATE', [genreId]);
      if (!before) throw ApiError.notFound('Genre');
      await tx.query('UPDATE genres SET name = ?, parent_genre_id = ?, color_hex = ?, description = ? WHERE genre_id = ?',
        [g.name, g.parentId || null, g.color, g.description || null, genreId]);
      await audit.record(tx, actor, 'GENRE_UPDATED', 'genre', genreId, before, g);
    } else {
      const r = await tx.query('INSERT INTO genres (name, parent_genre_id, color_hex, description) VALUES (?, ?, ?, ?)', [g.name, g.parentId || null, g.color, g.description || null]);
      await audit.record(tx, actor, 'GENRE_CREATED', 'genre', r.insertId, null, g);
    }
  }, { actorId: actor.id });
  return taxonomy();
}

async function deleteGenre(actor, genreId) {
  await withTransaction(async (tx) => {
    const g = await tx.one(`SELECT name, (SELECT COUNT(*) FROM song_genres WHERE genre_id = ?) AS songs,
                                   (SELECT COUNT(*) FROM genres WHERE parent_genre_id = ?) AS children,
                                   (SELECT COUNT(*) FROM artist_uploads WHERE genre_id = ?) AS uploads FROM genres WHERE genre_id = ?`, [genreId, genreId, genreId, genreId]);
    if (!g) throw ApiError.notFound('Genre');
    if (g.songs || g.children || g.uploads) throw new ApiError(409, 'GENRE_IN_USE', `“${g.name}” is used by ${g.songs} songs, ${g.uploads} uploads and ${g.children} sub-genres; move them first.`);
    await tx.query('DELETE FROM genres WHERE genre_id = ?', [genreId]);
    await audit.record(tx, actor, 'GENRE_DELETED', 'genre', genreId, { name: g.name });
  }, { actorId: actor.id });
  return taxonomy();
}

async function saveLanguage(actor, languageId, l) {
  await withTransaction(async (tx) => {
    if (languageId) {
      const before = await tx.one('SELECT iso_code, name, native_name, script FROM languages WHERE language_id = ? FOR UPDATE', [languageId]);
      if (!before) throw ApiError.notFound('Language');
      await tx.query('UPDATE languages SET iso_code = ?, name = ?, native_name = ?, script = ? WHERE language_id = ?', [l.iso, l.name, l.nativeName, l.script, languageId]);
      await audit.record(tx, actor, 'LANGUAGE_UPDATED', 'language', languageId, before, l);
    } else {
      const r = await tx.query('INSERT INTO languages (iso_code, name, native_name, script) VALUES (?, ?, ?, ?)', [l.iso, l.name, l.nativeName, l.script]);
      await audit.record(tx, actor, 'LANGUAGE_CREATED', 'language', r.insertId, null, l);
    }
  }, { actorId: actor.id });
  return taxonomy();
}

async function updateContext(actor, contextId, c) {
  await withTransaction(async (tx) => {
    const before = await tx.one('SELECT name, emoji, description FROM contexts WHERE context_id = ? FOR UPDATE', [contextId]);
    if (!before) throw ApiError.notFound('Listening context');
    await tx.query('UPDATE contexts SET name = COALESCE(?, name), emoji = COALESCE(?, emoji), description = COALESCE(?, description) WHERE context_id = ?',
      [c.name ?? null, c.emoji ?? null, c.description ?? null, contextId]);
    if (Array.isArray(c.phrases)) {
      await tx.query('DELETE FROM context_keywords WHERE context_id = ?', [contextId]);
      for (const p of [...new Set(c.phrases.map((x) => moodParser.normalise(x)).filter((x) => x.length >= 2))]) {
        await tx.query('INSERT IGNORE INTO context_keywords (phrase, context_id) VALUES (?, ?)', [p, contextId]);
      }
    }
    await audit.record(tx, actor, 'CONTEXT_UPDATED', 'context', contextId, before, c);
  }, { actorId: actor.id });
  moodParser.invalidate();
  return taxonomy();
}

// ---------------------------------------------------------------- recommender weights
async function weights() {
  return query(`SELECT mp.param_code AS code, mp.param_value AS value, mp.min_value AS min, mp.max_value AS max, mp.description,
                       im.name AS model, im.version
                  FROM model_parameters mp JOIN intelligence_models im ON im.model_id = mp.model_id
                 WHERE im.kind = 'RECOMMENDER' AND im.is_active = 1 ORDER BY mp.param_code`);
}

async function updateWeights(actor, changes) {
  await withTransaction(async (tx) => {
    const model = await tx.one("SELECT model_id FROM intelligence_models WHERE kind = 'RECOMMENDER' AND is_active = 1");
    if (!model) throw new ApiError(409, 'NO_ACTIVE_MODEL', 'No active recommender model.');
    for (const [code, value] of Object.entries(changes)) {
      const p = await tx.one('SELECT param_value, min_value, max_value FROM model_parameters WHERE model_id = ? AND param_code = ? FOR UPDATE', [model.model_id, code]);
      if (!p) throw ApiError.badRequest(`Unknown weight ${code}.`);
      if (value < Number(p.min_value) || value > Number(p.max_value)) throw ApiError.badRequest(`${code} must be between ${p.min_value} and ${p.max_value}.`);
      await tx.query('UPDATE model_parameters SET param_value = ? WHERE model_id = ? AND param_code = ?', [value, model.model_id, code]);   // trg_mp_au_audit
    }
    await audit.record(tx, actor, 'RECOMMENDER_TUNED', 'model', model.model_id, null, changes);
  }, { actorId: actor.id });
  return weights();
}

// ---------------------------------------------------------------- editorial picks
async function listPicks({ live = false } = {}) {
  return query(`SELECT p.pick_id AS id, p.song_id AS songId, s.title, a.name AS artist, p.headline, p.note, p.sort_order AS sortOrder,
                       p.starts_at AS startsAt, p.ends_at AS endsAt, s.status
                  FROM editorial_picks p JOIN songs s ON s.song_id = p.song_id JOIN artists a ON a.artist_id = s.primary_artist_id
                 ${live ? "WHERE s.status = 'ACTIVE' AND (p.starts_at IS NULL OR p.starts_at <= NOW()) AND (p.ends_at IS NULL OR p.ends_at > NOW())" : ''}
                 ORDER BY p.sort_order, p.pick_id`);
}

async function savePick(actor, pickId, p) {
  await withTransaction(async (tx) => {
    if (!(await tx.one('SELECT 1 AS ok FROM songs WHERE song_id = ?', [p.songId]))) throw ApiError.notFound('Song');
    if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) throw ApiError.badRequest('The end date must be after the start date.');
    if (pickId) {
      const r = await tx.query('UPDATE editorial_picks SET song_id = ?, headline = ?, note = ?, sort_order = ?, starts_at = ?, ends_at = ? WHERE pick_id = ?',
        [p.songId, p.headline, p.note || null, p.sortOrder || 0, p.startsAt || null, p.endsAt || null, pickId]);
      if (!r.affectedRows) throw ApiError.notFound('Pick');
    } else {
      await tx.query('INSERT INTO editorial_picks (song_id, headline, note, sort_order, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [p.songId, p.headline, p.note || null, p.sortOrder || 0, p.startsAt || null, p.endsAt || null, actor.id]);
    }
    await audit.record(tx, actor, pickId ? 'PICK_UPDATED' : 'PICK_CREATED', 'editorial_pick', pickId || 'new', null, p);
  }, { actorId: actor.id });
  return listPicks();
}

async function deletePick(actor, pickId) {
  const r = await query('DELETE FROM editorial_picks WHERE pick_id = ?', [pickId]);
  if (!r.affectedRows) throw ApiError.notFound('Pick');
  await audit.record(null, actor, 'PICK_DELETED', 'editorial_pick', pickId);
  return listPicks();
}

// ---------------------------------------------------------------- duplicates
async function duplicates() {
  const [sameFile, sameTitle, sameArtist] = await Promise.all([
    query(`SELECT au.sha256 AS hash, JSON_ARRAYAGG(JSON_OBJECT('upload', au.upload_id, 'title', au.title, 'artist', a.name, 'status', au.status, 'songId', au.song_id)) AS items
             FROM artist_uploads au JOIN artists a USING (artist_id) WHERE au.sha256 IS NOT NULL
            GROUP BY au.sha256 HAVING COUNT(*) > 1 LIMIT 50`),
    query(`SELECT LOWER(s.title) AS title, JSON_ARRAYAGG(JSON_OBJECT('id', s.song_id, 'title', s.title, 'artist', a.name, 'version', s.version_label, 'status', s.status)) AS items
             FROM songs s JOIN artists a ON a.artist_id = s.primary_artist_id WHERE s.status <> 'MERGED'
            GROUP BY LOWER(s.title), s.duration_sec DIV 5 HAVING COUNT(*) > 1 LIMIT 50`),
    query(`SELECT LOWER(name) AS name, JSON_ARRAYAGG(JSON_OBJECT('id', artist_id, 'name', name, 'disambiguation', disambiguation)) AS items
             FROM artists GROUP BY LOWER(name) HAVING COUNT(*) > 1 LIMIT 50`),
  ]);
  const parse = (rows) => rows.map((r) => ({ ...r, items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items }));
  return { sameFile: parse(sameFile), sameSong: parse(sameTitle), sameArtistName: parse(sameArtist) };
}

module.exports = {
  overview, badges, references, taxonomy, updateMood, addKeyword, removeKeyword, saveGenre, deleteGenre, saveLanguage, updateContext,
  weights, updateWeights, listPicks, savePick, deletePick, duplicates, systemHealth,
};
