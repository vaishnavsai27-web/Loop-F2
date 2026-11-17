// The audio upload pipeline, for Artists (their own recordings) and Admins (LOOP-owned recordings).
//
//   UPLOADING ──file──▶ QUARANTINED ──scan worker──▶ PENDING_REVIEW ──approve + sound profile──▶ APPROVED ──publish──▶ PUBLISHED
//        │                  │   ▲ scanner offline: retried with back-off           │                    │
//        │ (no file in 2 h) │   └──────────────────────────────────────────┐       │ reject (reason)    │ withdraw / takedown
//        ▼                  ▼ invalid audio / duplicate / infected          │       ▼                    ▼
//   PROCESSING_FAILED   PROCESSING_FAILED / REJECTED (file deleted)          └──  REJECTED          TAKEN_DOWN (file retained privately)
//
// Nothing is playable before PUBLISHED. A file is marked CLEAN only after ClamAV answered "OK".
// Files live on persistent storage (a Railway volume in production); see providers/localMedia.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { pipeline: pipe } = require('stream/promises');
const { Transform } = require('stream');
const { query, one, withTransaction } = require('../config/db');
const { session, uploadOrigin } = require('../config/env');
const { localMedia } = require('../providers');
const ApiError = require('../utils/ApiError');
const { AUDIO_TYPES, detectAudio, safeUploadId, isSupportedAudioCodec } = require('../utils/audioSignature');
const audit = require('./auditService');
const notify = require('./notifyService');
const settings = require('./settingsService');
const artists = require('./artistService');
const catalogAdmin = require('./catalogAdminService');
const log = require('../utils/log');

/** Delete a file that may already be gone. Anything other than "not there" is logged, never hidden. */
const removeFile = (file) => fs.promises.unlink(file).catch((err) => {
  if (err.code !== 'ENOENT') log.warn('upload file could not be deleted', { file: path.basename(file), code: err.code });
});
const retainFile = (file) => localMedia.retain(file).catch((err) => log.warn('replaced media file could not be moved to retained/', { file, code: err.code || err.message }));

const HARD_MAX_BYTES = 50 * 1024 * 1024;
const OPEN = ['UPLOADING', 'QUARANTINED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED'];
const quarantineDir = () => localMedia.sub('artist-quarantine');
const quarantinePath = (id, ext) => path.join(quarantineDir(), `${id}.${ext}`);
const tempPath = (id) => path.join(quarantineDir(), `.${id}.part`);
const finalMediaName = (u, ext) => `${u.source === 'ADMIN' ? 'loop' : 'artist'}_${u.upload_id}.${ext}`;
const ipHash = (ip) => crypto.createHmac('sha256', session.secret || 'local-only').update(`artist-ip:${ip || 'unknown'}`).digest('hex');
const extOf = (u) => String(u.file_name || '').split('.').pop();
const uploadToken = (id) => crypto.createHmac('sha256', session.secret || 'local-only').update(`upload:${id}`).digest('base64url');
const tokenMatches = (id, given) => typeof given === 'string' && given.length === 43
  && crypto.timingSafeEqual(Buffer.from(uploadToken(id)), Buffer.from(given));

async function maxBytes() { return Math.min(HARD_MAX_BYTES, (await settings.get('upload_max_mb')) * 1024 * 1024); }

const event = (tx, id, actor, code, from, to, note = null) => tx.query(
  `INSERT INTO artist_upload_events (upload_id, actor_user_id, event_code, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)`,
  [id, actor ? actor.id || actor : null, code, from || null, to || null, note ? String(note).slice(0, 500) : null]);

async function removeQuarantine(u) {
  const ext = extOf(u);
  if (Object.values(AUDIO_TYPES).some((t) => t.ext === ext)) await removeFile(quarantinePath(u.upload_id, ext));
  await removeFile(tempPath(u.upload_id));
}

function requireWritableStorage() {
  const s = localMedia.check();
  if (!s.writable) {
    throw new ApiError(503, 'UPLOAD_STORAGE_UNAVAILABLE', s.state === 'ephemeral'
      ? 'Uploads are paused: LOOP’s audio storage is not on a persistent volume yet, so files would be lost on the next deploy.'
      : 'Audio uploads are switched off on this deployment.');
  }
}
function clamavScan(file) {
  const host = process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT || 3310);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(503, 'SCANNER_NOT_CONFIGURED', 'ClamAV is not configured. The upload remains private in quarantine.');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    let settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; socket.destroy(); err ? reject(err) : resolve(value); };
    socket.setTimeout(30000, () => finish(new ApiError(503, 'SCANNER_TIMEOUT', 'The malware scanner timed out.')));
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.on('error', (err) => finish(new ApiError(503, 'SCANNER_UNAVAILABLE', `ClamAV could not scan the quarantined file: ${err.message}`)));
    socket.on('end', () => {
      if (/stream: OK/i.test(response)) return finish(null, { clean: true, detail: 'ClamAV: OK' });
      if (/FOUND/i.test(response)) return finish(null, { clean: false, detail: response.trim().slice(0, 450) });
      finish(new ApiError(503, 'SCANNER_INVALID_RESPONSE', `ClamAV returned an unexpected response: ${response.slice(0, 120)}`));
    });
    socket.on('connect', async () => {
      try {
        socket.write('zINSTREAM\0');
        for await (const chunk of fs.createReadStream(file)) {
          const header = Buffer.alloc(4); header.writeUInt32BE(chunk.length, 0);
          if (!socket.write(Buffer.concat([header, chunk]))) await new Promise((r) => socket.once('drain', r));
        }
        socket.end(Buffer.alloc(4));
      } catch (err) { finish(new ApiError(503, 'SCANNER_STREAM_FAILED', err.message)); }
    });
  });
}

function probeAudio(file) {
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.stdout.on('data', (x) => { stdout += x.toString(); });
    child.stderr.on('data', (x) => { stderr += x.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new ApiError(503, 'FFPROBE_UNAVAILABLE', `ffprobe could not start: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new ApiError(503, 'FFPROBE_TIMEOUT', 'ffprobe took too long to inspect the quarantined file.'));
      if (code !== 0) return reject(new ApiError(422, 'INVALID_AUDIO_MEDIA', `ffprobe rejected the audio container: ${stderr.slice(0, 250)}`));
      try {
        const data = JSON.parse(stdout);
        const duration = Math.round(Number(data.format?.duration));
        if (!Array.isArray(data.streams) || !data.streams.some((s) => s.codec_type === 'audio')) throw new Error('No audio stream detected.');
        if (data.streams.some((s) => s.codec_type === 'video')) throw new Error('Video streams are not supported. Upload an audio-only recording.');
        const audio = data.streams.find((s) => s.codec_type === 'audio');
        if (!isSupportedAudioCodec(audio.codec_name)) throw new Error(`Audio codec ${audio.codec_name || 'unknown'} is not supported. Use MP3, AAC, FLAC, Vorbis, Opus or standard PCM audio.`);
        if (!Number.isInteger(duration) || duration < 30 || duration > 1800) throw new Error('Audio duration must be between 30 seconds and 30 minutes.');
        resolve(duration);
      } catch (err) { reject(new ApiError(422, 'INVALID_AUDIO_MEDIA', err.message)); }
    });
  });
}

const SCANNER_ERRORS = new Set(['SCANNER_NOT_CONFIGURED', 'SCANNER_TIMEOUT', 'SCANNER_UNAVAILABLE', 'SCANNER_INVALID_RESPONSE',
  'SCANNER_STREAM_FAILED', 'FFPROBE_UNAVAILABLE', 'FFPROBE_TIMEOUT']);
const scannerConfigured = () => !!process.env.CLAMAV_HOST;

// ---------------------------------------------------------------- intents
/**
 * Start an upload. Artists upload for an artist profile they manage; Admins (media.manage) upload
 * LOOP-owned recordings for any artist, optionally replacing the audio of an existing song.
 */
async function createIntent(actor, ip, data, { source = 'ARTIST' } = {}) {
  requireWritableStorage();
  const cfg = await settings.all();
  const limit = await maxBytes();
  if (data.rightsAccepted !== true) throw ApiError.badRequest('You must accept the LOOP rights declaration before uploading.');
  if (data.fileSize > limit) throw new ApiError(413, 'UPLOAD_TOO_LARGE', `The largest file LOOP accepts is ${Math.round(limit / 1048576)} MB.`);
  const declaredMime = String(data.mimeType || '').split(';')[0].toLowerCase();
  const allowedMimeTypes = new Set(['application/octet-stream', 'audio/x-wav', 'audio/x-m4a', 'audio/x-flac', 'audio/mp3', ...Object.values(AUDIO_TYPES).map((x) => x.mime)]);
  if (!allowedMimeTypes.has(declaredMime)) throw ApiError.badRequest('That file type is not supported. Use MP3, WAV, FLAC, OGG, AAC or M4A.');
  const evidence = data.rightsEvidenceRef || null;
  if ((data.compositionRights === 'LICENSED' || data.recordingRights === 'LICENSED') && !evidence) {
    throw ApiError.badRequest('Add an https:// link to the licence when the composition or recording is licensed.');
  }
  if (data.licenceStart && data.licenceEnd && data.licenceEnd < data.licenceStart) throw ApiError.badRequest('The licence end date must not be earlier than the start date.');
  const territories = Array.isArray(data.territories) && data.territories.length ? data.territories : ['WORLDWIDE'];
  if (territories.includes('WORLDWIDE') && territories.length > 1) throw ApiError.badRequest('Use WORLDWIDE by itself or list specific country codes.');
  const id = crypto.randomBytes(16).toString('hex');
  await withTransaction(async (tx) => {
    await tx.query('SELECT user_id FROM users WHERE user_id = ? FOR UPDATE', [actor.id]);   // serialises quota checks per account
    if (source === 'ARTIST') {
      if (!(await artists.activeArtistAccount(tx, actor.id, data.artistId))) throw ApiError.forbidden('You do not manage an active artist profile with that ID.');
      const quota = await tx.one(
        `SELECT COALESCE(SUM(IF(status IN ('QUARANTINED','PROCESSING','PENDING_REVIEW','APPROVED','PUBLISHED'), COALESCE(file_size, 0), 0)), 0) AS used_bytes,
                COALESCE(SUM(status IN ('UPLOADING','QUARANTINED','PROCESSING','PENDING_REVIEW','APPROVED')), 0) AS open_uploads
           FROM artist_uploads WHERE user_id = ? AND source = 'ARTIST' AND created_at >= NOW() - INTERVAL 30 DAY`, [actor.id]);
      if (Number(quota.used_bytes) + data.fileSize > cfg.upload_quota_mb * 1048576) throw new ApiError(429, 'ARTIST_QUOTA_EXCEEDED', `You have used your ${cfg.upload_quota_mb} MB upload allowance for the last 30 days.`);
      if (Number(quota.open_uploads) >= cfg.open_uploads_per_artist) throw new ApiError(429, 'TOO_MANY_PENDING_UPLOADS', `You already have ${cfg.open_uploads_per_artist} recordings in progress. Wait for a decision, or withdraw one.`);
    } else if (!(await tx.one('SELECT 1 AS ok FROM artists WHERE artist_id = ?', [data.artistId]))) {
      throw ApiError.notFound('Artist');
    }
    // Duplicate title: an open upload or a live song with the same artist, title and version.
    const versionLabel = data.versionLabel || '';
    let targetSongId = data.targetSongId || null;
    if (targetSongId) {
      if (source !== 'ADMIN') throw ApiError.forbidden();
      const t = await tx.one('SELECT song_id FROM songs WHERE song_id = ? AND primary_artist_id = ?', [targetSongId, data.artistId]);
      if (!t) throw ApiError.badRequest('That song does not belong to the chosen artist.');
    } else {
      const openDup = await tx.one(`SELECT upload_id FROM artist_uploads WHERE artist_id = ? AND LOWER(title) = LOWER(?) AND version_label = ?
                                     AND status IN ('UPLOADING','QUARANTINED','PROCESSING','PENDING_REVIEW','APPROVED') LIMIT 1`, [data.artistId, data.title, versionLabel]);
      if (openDup) throw new ApiError(409, 'DUPLICATE_UPLOAD', 'This recording is already uploaded and waiting for review.');
      const song = await tx.one(`SELECT song_id, status, moderation_state FROM songs WHERE primary_artist_id = ? AND LOWER(title) = LOWER(?) AND version_label = ?`,
        [data.artistId, data.title, versionLabel]);
      if (song) {
        // A song the same artist withdrew (or that lost its audio) is re-used: the new recording replaces it.
        const reusable = song.moderation_state === 'WITHDRAWN' || (source === 'ADMIN' && song.moderation_state === 'CLEAR');
        if (!reusable) {
          throw new ApiError(409, 'DUPLICATE_SONG', song.moderation_state === 'CLEAR'
            ? 'This artist already has a song with that title and version on LOOP. Add a version label (for example “Acoustic”) if it is a different recording.'
            : 'A song with that title was removed by LOOP moderation. Contact LOOP before uploading it again.');
        }
        targetSongId = song.song_id;
      }
    }
    await tx.query(
      `INSERT INTO artist_uploads
       (upload_id, user_id, artist_id, source, target_song_id, title, version_label, genre_id, language_id, duration_claim_sec,
        release_year, explicit, description, declared_size, declared_mime, composition_rights, recording_rights,
        rights_evidence_ref, territory_codes, allowed_uses, licence_start, licence_end,
        royalty_share_pct, royalty_currency, rights_terms_version, rights_accepted_at, rights_ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [id, actor.id, data.artistId, source, targetSongId, data.title, versionLabel, data.genreId, data.languageId || null,
        data.durationSec, data.releaseYear, data.explicit ? 1 : 0, data.description || null, data.fileSize, declaredMime,
        data.compositionRights, data.recordingRights, evidence, JSON.stringify(territories), JSON.stringify(['INTERACTIVE_STREAMING']),
        data.licenceStart || null, data.licenceEnd || null, data.royaltySharePct ?? 0, data.royaltyCurrency || 'INR', artists.TERMS_VERSION, ipHash(ip)]);
    await event(tx, id, actor, 'UPLOAD_INTENT_CREATED', null, 'UPLOADING', source === 'ADMIN' ? 'LOOP-owned recording started by an Admin.' : 'Rights declaration accepted.');
  }, { actorId: actor.id });
  const pathPart = `/api/uploads/${id}/content`;
  return { id, status: 'UPLOADING', uploadUrl: uploadOrigin ? `${uploadOrigin}${pathPart}` : pathPart, uploadToken: uploadToken(id),
    method: 'PUT', maxBytes: limit, termsVersion: artists.TERMS_VERSION };
}

/**
 * Receive the file. Authorised by the signed-in uploader OR the upload token issued with the intent
 * (so browsers can send large files straight to the API host instead of through the Vercel proxy).
 */
async function storeFile(id, req, { userId = null, token = null } = {}) {
  requireWritableStorage();
  if (!safeUploadId(id)) throw ApiError.notFound('Upload');
  const upload = await one('SELECT * FROM artist_uploads WHERE upload_id = ?', [id]);
  if (!upload || !(upload.user_id === userId || tokenMatches(id, token))) throw ApiError.notFound('Upload');
  if (upload.source === 'ARTIST' && !(await artists.activeArtistAccount(null, upload.user_id, upload.artist_id))) throw ApiError.forbidden('This artist profile is no longer active.');
  if (upload.status !== 'UPLOADING') throw ApiError.conflict('UPLOAD_NOT_OPEN', 'This upload already received its file. Start a new upload to send another one.');
  const limit = await maxBytes();
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1 || length > limit || length !== Number(upload.declared_size)) {
    throw new ApiError(400, 'UPLOAD_LENGTH_MISMATCH', 'The file size does not match what was declared. Start the upload again.');
  }
  await fs.promises.mkdir(quarantineDir(), { recursive: true, mode: 0o700 });
  const temp = tempPath(id);
  await removeFile(temp);   // a retried transfer replaces a half-written one
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({ transform(chunk, enc, cb) {
    bytes += chunk.length;
    if (bytes > length) return cb(new ApiError(413, 'UPLOAD_TOO_LARGE', 'The upload is larger than declared.'));
    hash.update(chunk);
    cb(null, chunk);
  } });
  let finalPath = null;
  try {
    await pipe(req, counter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (bytes !== length) throw new ApiError(400, 'UPLOAD_LENGTH_MISMATCH', 'The transfer was cut short. Try again.');
    const fd = await fs.promises.open(temp, 'r');
    const head = Buffer.alloc(32);
    await fd.read(head, 0, head.length, 0);
    await fd.close();
    const detected = detectAudio(head);
    if (!detected) throw new ApiError(415, 'NOT_AUDIO', 'This file is not an audio file LOOP can read (MP3, WAV, FLAC, OGG, AAC or M4A).');
    const checksum = hash.digest('hex');
    const dup = await one(`SELECT au.title, a.name AS artist FROM artist_uploads au JOIN artists a USING (artist_id)
                            WHERE au.sha256 = ? AND au.upload_id <> ? AND au.status NOT IN ('REJECTED','PROCESSING_FAILED') LIMIT 1`, [checksum, id]);
    if (dup) {
      await withTransaction(async (tx) => {
        await tx.query("UPDATE artist_uploads SET status = 'PROCESSING_FAILED', failure_reason = ?, sha256 = ? WHERE upload_id = ?",
          [`This exact file was already uploaded as “${dup.title}” by ${dup.artist}.`, checksum, id]);
        await event(tx, id, userId, 'DUPLICATE_FILE', 'UPLOADING', 'PROCESSING_FAILED', `Same file as “${dup.title}”.`);
      });
      throw new ApiError(409, 'DUPLICATE_AUDIO', `This exact file is already on LOOP as “${dup.title}” by ${dup.artist}.`);
    }
    finalPath = quarantinePath(id, detected.ext);
    await fs.promises.rename(temp, finalPath);
    await withTransaction(async (tx) => {
      const r = await tx.query(
        `UPDATE artist_uploads SET status = 'QUARANTINED', scan_status = 'NOT_SCANNED', file_name = ?, file_size = ?, detected_mime = ?,
                sha256 = ?, next_scan_at = NOW(), failure_reason = NULL WHERE upload_id = ? AND status = 'UPLOADING'`,
        [`${id}.${detected.ext}`, bytes, detected.mime, checksum, id]);
      if (!r.affectedRows) throw ApiError.conflict('UPLOAD_NOT_OPEN', 'This upload was already finished.');
      await event(tx, id, upload.user_id, 'FILE_QUARANTINED', 'UPLOADING', 'QUARANTINED', `File received (${bytes} bytes, ${detected.mime}).`);
    });
    // Scan right away when a scanner is configured; the worker retries anything that fails.
    if (scannerConfigured()) setImmediate(() => scanUpload(id, null).catch((err) => log.warn('upload scan will be retried by the pipeline', { uploadId: id, code: err.code || err.message })));
    return { id, status: 'QUARANTINED', bytes, mimeType: detected.mime,
      message: scannerConfigured() ? 'Received. LOOP is checking the file now.' : 'Received. It will be checked as soon as LOOP’s scanner is available.' };
  } catch (err) {
    await removeFile(temp);
    if (finalPath) await removeFile(finalPath);
    throw err;
  }
}

// ---------------------------------------------------------------- scanning
async function scanUpload(uploadId, actor = null) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const upload = await one('SELECT * FROM artist_uploads WHERE upload_id = ?', [uploadId]);
  if (!upload) throw ApiError.notFound('Upload');
  if (upload.status !== 'QUARANTINED') throw ApiError.conflict('UPLOAD_NOT_SCANNABLE', 'Only uploads waiting in quarantine can be scanned.');
  const ext = extOf(upload);
  const file = quarantinePath(uploadId, ext);
  if (!Object.values(AUDIO_TYPES).some((t) => t.ext === ext) || !fs.existsSync(file)) {
    await failUpload(upload, actor, 'The uploaded file is missing from storage. Upload it again.', 'FILE_MISSING');
    throw new ApiError(410, 'UPLOAD_FILE_MISSING', 'The uploaded file is missing from storage, so this upload was closed. The artist can upload it again.');
  }
  const claimed = await query("UPDATE artist_uploads SET status = 'PROCESSING', scan_attempts = scan_attempts + 1 WHERE upload_id = ? AND status = 'QUARANTINED'", [uploadId]);
  if (!claimed.affectedRows) throw ApiError.conflict('UPLOAD_SCAN_IN_PROGRESS', 'This upload is already being scanned.');
  let scan;
  try {
    scan = await clamavScan(file);
  } catch (err) {
    await retryLater(upload, actor, err);
    throw err;
  }
  if (!scan.clean) {
    await withTransaction(async (tx) => {
      await tx.query("UPDATE artist_uploads SET status = 'REJECTED', scan_status = 'INFECTED', scan_detail = ?, failure_reason = 'Malware was found in the file.' WHERE upload_id = ?", [scan.detail, uploadId]);
      await event(tx, uploadId, actor, 'MALWARE_DETECTED', 'PROCESSING', 'REJECTED', scan.detail);
      await audit.record(tx, actor, 'UPLOAD_REJECTED_MALWARE', 'artist_upload', uploadId, null, { detail: scan.detail });
      await notify.notify(tx, upload.user_id, { kind: 'UPLOAD_REJECTED', title: `“${upload.title}” was rejected`, body: 'The malware scanner flagged this file, so it was deleted.', link: '/studio/submissions', email: true });
    });
    await removeFile(file);
    return { id: uploadId, status: 'REJECTED', scanStatus: 'INFECTED' };
  }
  let duration;
  try {
    duration = await probeAudio(file);
  } catch (err) {
    if (SCANNER_ERRORS.has(err.code)) { await retryLater(upload, actor, err); throw err; }
    await failUpload(upload, actor, `The file is not usable audio: ${err.message}`, 'INVALID_AUDIO');
    return { id: uploadId, status: 'PROCESSING_FAILED', reason: err.message };
  }
  const mismatch = Math.abs(duration - upload.duration_claim_sec) > 10 ? ` Declared ${upload.duration_claim_sec}s, file is ${duration}s.` : '';
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE artist_uploads SET status = 'PENDING_REVIEW', scan_status = 'CLEAN', scan_detail = ?, duration_verified_sec = ?,
                    failure_reason = NULL, next_scan_at = NULL WHERE upload_id = ?`, [`${scan.detail}; ffprobe ${duration}s.${mismatch}`, duration, uploadId]);
    await event(tx, uploadId, actor, 'SCAN_PASSED', 'PROCESSING', 'PENDING_REVIEW', `${scan.detail}; ffprobe duration ${duration}s.${mismatch}`);
    await audit.record(tx, actor, 'UPLOAD_SCANNED_CLEAN', 'artist_upload', uploadId, null, { duration });
    if (upload.source === 'ARTIST') {
      await notify.notifyAdmins(tx, { kind: 'ADMIN_UPLOAD', title: `New recording to review: “${upload.title}”`, link: `/admin/uploads/${uploadId}` });
      await notify.notify(tx, upload.user_id, { kind: 'UPLOAD_CHECKED', title: `“${upload.title}” passed the checks`, body: 'It is now waiting for an Admin to review it.', link: '/studio/submissions' });
    }
  });
  return { id: uploadId, status: 'PENDING_REVIEW', scanStatus: 'CLEAN', durationSec: duration };
}

async function retryLater(upload, actor, err) {
  const attempts = upload.scan_attempts + 1;
  const minutes = Math.min(360, 2 ** Math.min(attempts, 9));
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE artist_uploads SET status = 'QUARANTINED', scan_status = 'ERROR', failure_reason = ?, next_scan_at = NOW() + INTERVAL ? MINUTE
                     WHERE upload_id = ?`, [`Waiting for the scanner: ${String(err.message).slice(0, 400)}`, minutes, upload.upload_id]);
    await event(tx, upload.upload_id, actor, 'SCAN_RETRY_SCHEDULED', 'PROCESSING', 'QUARANTINED', `${err.message} — retry in ${minutes} min.`);
  });
}

async function failUpload(upload, actor, reason, code) {
  await withTransaction(async (tx) => {
    await tx.query("UPDATE artist_uploads SET status = 'PROCESSING_FAILED', failure_reason = ?, next_scan_at = NULL WHERE upload_id = ?", [reason.slice(0, 500), upload.upload_id]);
    await event(tx, upload.upload_id, actor, code, upload.status, 'PROCESSING_FAILED', reason);
    await audit.record(tx, actor, 'UPLOAD_PROCESSING_FAILED', 'artist_upload', upload.upload_id, null, { reason });
    await notify.notify(tx, upload.user_id, { kind: 'UPLOAD_FAILED', title: `“${upload.title}” could not be processed`, body: reason, link: '/studio/submissions', email: true });
  });
  await removeQuarantine(upload);
}

/** Background worker: scan due uploads; close intents whose file never arrived. */
async function runPipeline({ limit = 5 } = {}) {
  const expired = await query(`SELECT * FROM artist_uploads WHERE status = 'UPLOADING' AND created_at < NOW() - INTERVAL 2 HOUR LIMIT 50`);
  for (const u of expired) {
    await withTransaction(async (tx) => {
      const r = await tx.query("UPDATE artist_uploads SET status = 'PROCESSING_FAILED', failure_reason = 'The file never arrived. Start the upload again.' WHERE upload_id = ? AND status = 'UPLOADING'", [u.upload_id]);
      if (r.affectedRows) await event(tx, u.upload_id, null, 'INTENT_EXPIRED', 'UPLOADING', 'PROCESSING_FAILED', 'No file within 2 hours.');
    });
    await removeQuarantine(u);
  }
  // A worker that died mid-scan leaves PROCESSING behind; put it back in the queue.
  await query("UPDATE artist_uploads SET status = 'QUARANTINED', next_scan_at = NOW() WHERE status = 'PROCESSING' AND updated_at < NOW() - INTERVAL 15 MINUTE");
  let scanned = 0;
  if (scannerConfigured() && localMedia.writable()) {
    const due = await query(`SELECT upload_id FROM artist_uploads WHERE status = 'QUARANTINED' AND (next_scan_at IS NULL OR next_scan_at <= NOW())
                             ORDER BY created_at LIMIT ?`, [limit]);
    for (const u of due) {
      try { await scanUpload(u.upload_id, null); scanned += 1; } catch (err) { log.warn('scan_deferred', { upload: u.upload_id, code: err.code }); }
    }
  }
  return { expired: expired.length, scanned };
}

async function scannerStatus() {
  if (!scannerConfigured()) return { state: 'not_configured', detail: 'Set CLAMAV_HOST to a ClamAV service. Uploads wait in quarantine until then.' };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: process.env.CLAMAV_HOST, port: Number(process.env.CLAMAV_PORT || 3310) });
    const done = (state, detail) => { socket.destroy(); resolve({ state, detail }); };
    socket.setTimeout(3000, () => done('unreachable', 'ClamAV did not answer within 3 seconds.'));
    socket.on('error', (err) => done('unreachable', err.message));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (d) => done(/PONG/.test(d.toString()) ? 'ready' : 'unreachable', d.toString().trim().slice(0, 80)));
  });
}

// ---------------------------------------------------------------- review
async function listUploads({ status = 'PENDING_REVIEW', source = null, q = '', page = 1, pageSize = 25 }) {
  const where = ["(? = 'ALL' OR au.status = ?)"]; const params = [status, status];
  if (source) { where.push('au.source = ?'); params.push(source); }
  if (q) { where.push('(au.title LIKE ? OR a.name LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const from = 'FROM artist_uploads au JOIN users u USING (user_id) JOIN artists a USING (artist_id)';
  const [{ total }] = await query(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, params);
  const rows = await query(
    `SELECT au.upload_id AS id, au.source, au.user_id AS userId, u.username, u.is_active AS uploaderActive, au.artist_id AS artistId, a.name AS artistName,
            au.title, au.version_label AS versionLabel, au.song_id AS songId, au.target_song_id AS targetSongId,
            au.duration_verified_sec AS durationSec, au.file_size AS fileSize, au.status, au.scan_status AS scanStatus,
            au.failure_reason AS failureReason, au.created_at AS createdAt, au.updated_at AS updatedAt, au.review_note AS reviewNote,
            au.next_scan_at AS nextScanAt, au.scan_attempts AS scanAttempts
       ${from} WHERE ${where.join(' AND ')} ORDER BY au.created_at ${['PENDING_REVIEW', 'QUARANTINED', 'APPROVED'].includes(status) ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { total, page, pageSize, uploads: rows.map((r) => ({ ...r, uploaderActive: !!r.uploaderActive })) };
}

async function uploadDetail(uploadId, { userId = null } = {}) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const u = await one(
    `SELECT au.*, a.name AS artist_name, us.username, us.is_active AS uploader_active, g.name AS genre_name, l.name AS language_name,
            (SELECT aa.account_status FROM artist_accounts aa WHERE aa.user_id = au.user_id AND aa.artist_id = au.artist_id) AS account_status
       FROM artist_uploads au JOIN artists a USING (artist_id) JOIN users us ON us.user_id = au.user_id
       LEFT JOIN genres g ON g.genre_id = au.genre_id LEFT JOIN languages l ON l.language_id = au.language_id
      WHERE au.upload_id = ?`, [uploadId]);
  if (!u || (userId && u.user_id !== userId)) throw ApiError.notFound('Upload');
  const events = await query(
    `SELECT e.event_code AS code, e.from_status AS fromStatus, e.to_status AS toStatus, e.note, e.created_at AS createdAt,
            COALESCE(us.username, 'LOOP') AS actor
       FROM artist_upload_events e LEFT JOIN users us ON us.user_id = e.actor_user_id WHERE e.upload_id = ? ORDER BY e.event_id`, [uploadId]);
  const song = u.song_id || u.target_song_id ? await one('SELECT song_id, title, status, moderation_state FROM songs WHERE song_id = ?', [u.song_id || u.target_song_id]) : null;
  const features = song ? await one('SELECT energy, valence, danceability, acousticness, instrumentalness, speechiness, tempo_bpm, loudness_db, musical_key AS `key`, mode FROM audio_features WHERE song_id = ? AND is_current = 1', [song.song_id]) : null;
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    id: u.upload_id, source: u.source, userId: u.user_id, username: u.username, uploaderActive: !!u.uploader_active, accountStatus: u.account_status,
    artistId: u.artist_id, artistName: u.artist_name, title: u.title, versionLabel: u.version_label, description: u.description,
    genreId: u.genre_id, genre: u.genre_name, languageId: u.language_id, language: u.language_name, releaseYear: u.release_year, explicit: !!u.explicit,
    durationClaimSec: u.duration_claim_sec, durationSec: u.duration_verified_sec, fileSize: u.file_size, mimeType: u.detected_mime,
    status: u.status, scanStatus: u.scan_status, scanDetail: u.scan_detail, failureReason: u.failure_reason, reviewNote: u.review_note,
    compositionRights: u.composition_rights, recordingRights: u.recording_rights, evidenceRef: u.rights_evidence_ref,
    territories: parse(u.territory_codes), licenceStart: u.licence_start, licenceEnd: u.licence_end,
    royaltySharePct: Number(u.royalty_share_pct), royaltyCurrency: u.royalty_currency, termsVersion: u.rights_terms_version,
    createdAt: u.created_at, updatedAt: u.updated_at, songId: u.song_id, targetSongId: u.target_song_id, song,
    artworkUrl: u.artwork_file ? `/api/artwork/${u.artwork_file}` : null,
    canPreview: ['PENDING_REVIEW', 'APPROVED'].includes(u.status) && u.scan_status === 'CLEAN',
    soundProfile: features, events,
  };
}

/** The reviewer listens before deciding. Only scanned (CLEAN) files, only to reviewers. */
async function previewFile(uploadId) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const u = await one('SELECT upload_id, file_name, status, scan_status, detected_mime FROM artist_uploads WHERE upload_id = ?', [uploadId]);
  if (!u || u.scan_status !== 'CLEAN' || !['PENDING_REVIEW', 'APPROVED'].includes(u.status)) throw ApiError.notFound('Recording to preview');
  const full = quarantinePath(uploadId, extOf(u));
  if (!fs.existsSync(full)) throw new ApiError(404, 'MEDIA_MISSING', 'The uploaded file is missing from storage.');
  return { full, type: u.detected_mime || 'application/octet-stream' };
}

const META = { title: 'title', versionLabel: 'version_label', genreId: 'genre_id', languageId: 'language_id', releaseYear: 'release_year',
  explicit: 'explicit', description: 'description' };

/**
 * Approve (with any metadata corrections and the required sound profile) or reject (with a reason).
 * Rejection is possible at any point before publication and deletes the private file.
 */
async function decide(actor, uploadId, { action, note = null, metadata = {}, features = null, publish = false }) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const result = await withTransaction(async (tx) => {
    const u = await tx.one('SELECT * FROM artist_uploads WHERE upload_id = ? FOR UPDATE', [uploadId]);
    if (!u) throw ApiError.notFound('Upload');
    if (u.source === 'ARTIST' && u.user_id === actor.id) throw ApiError.forbidden('You cannot review your own upload.');
    if (action === 'REJECT') {
      if (!String(note || '').trim()) throw ApiError.badRequest('Tell the uploader why the recording was rejected.');
      if (!['QUARANTINED', 'PROCESSING_FAILED', 'PENDING_REVIEW', 'APPROVED'].includes(u.status)) {
        throw ApiError.conflict('UPLOAD_NOT_REVIEWABLE', u.status === 'PUBLISHED' ? 'This recording is live. Use Take down on the song instead.' : 'This upload is already closed.');
      }
      await tx.query("UPDATE artist_uploads SET status = 'REJECTED', reviewer_user_id = ?, review_note = ?, reviewed_at = NOW(), next_scan_at = NULL WHERE upload_id = ?", [actor.id, note, uploadId]);
      await event(tx, uploadId, actor, 'MODERATOR_REJECTED', u.status, 'REJECTED', note);
      await audit.record(tx, actor, 'UPLOAD_REJECTED', 'artist_upload', uploadId, { status: u.status }, { note });
      if (u.source === 'ARTIST') await notify.notify(tx, u.user_id, { kind: 'UPLOAD_REJECTED', title: `“${u.title}” was not approved`, body: note, link: '/studio/submissions', email: true });
      return { u, status: 'REJECTED' };
    }
    if (action !== 'APPROVE') throw ApiError.badRequest('Decision must be APPROVE or REJECT.');
    if (u.status !== 'PENDING_REVIEW' || u.scan_status !== 'CLEAN') throw ApiError.conflict('UPLOAD_NOT_REVIEWABLE', 'Only recordings that passed the malware and audio checks can be approved.');
    if ((u.composition_rights === 'LICENSED' || u.recording_rights === 'LICENSED') && !u.rights_evidence_ref) {
      throw ApiError.conflict('RIGHTS_EVIDENCE_MISSING', 'A licensed composition or recording needs a link to the licence.');
    }
    if (u.source === 'ARTIST' && !(await artists.activeArtistAccount(tx, u.user_id, u.artist_id))) {
      throw ApiError.conflict('ARTIST_ACCOUNT_INACTIVE', 'The uploader’s account or artist profile is suspended or deactivated.');
    }
    // Reviewer corrections to the metadata before anything becomes public.
    const sets = []; const params = [];
    for (const [k, col] of Object.entries(META)) {
      if (metadata[k] === undefined) continue;
      sets.push(`${col} = ?`); params.push(k === 'explicit' ? (metadata[k] ? 1 : 0) : metadata[k] === '' ? null : metadata[k]);
    }
    if (sets.length) {
      await tx.query(`UPDATE artist_uploads SET ${sets.join(', ')} WHERE upload_id = ?`, [...params, uploadId]);
      await event(tx, uploadId, actor, 'METADATA_CORRECTED', u.status, u.status, Object.keys(metadata).join(', '));
    }
    const m = await tx.one('SELECT * FROM artist_uploads WHERE upload_id = ?', [uploadId]);
    let songId = m.target_song_id;
    if (songId) {
      const hasFeatures = await tx.one('SELECT 1 AS ok FROM audio_features WHERE song_id = ? AND is_current = 1', [songId]);
      if (!hasFeatures && !features) throw new ApiError(400, 'SOUND_PROFILE_REQUIRED', 'Add the sound profile so the song can be recommended.');
      await tx.query(`UPDATE songs SET title = ?, version_label = ?, language_id = ?, release_year = ?, explicit = ?, description = COALESCE(?, description),
                      duration_sec = ?, content_rating = IF(? = 1 AND content_rating = 'ALL', 'TEEN', content_rating) WHERE song_id = ?`,
        [m.title, m.version_label, m.language_id, m.release_year, m.explicit, m.description, m.duration_verified_sec, m.explicit, songId]);
      await tx.query('DELETE FROM song_genres WHERE song_id = ? AND is_primary = 1', [songId]);
      await tx.query('INSERT INTO song_genres (song_id, genre_id, is_primary) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE is_primary = 1', [songId, m.genre_id]);
    } else {
      if (!features) throw new ApiError(400, 'SOUND_PROFILE_REQUIRED', 'Add the sound profile so the song can be recommended.');
      const created = await tx.query(
        `INSERT INTO songs (title, version_label, primary_artist_id, duration_sec, release_year, language_id, explicit, content_rating, popularity, status, description, artwork_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 50, 'PENDING_ANALYSIS', ?, ?)`,
        [m.title, m.version_label, m.artist_id, m.duration_verified_sec, m.release_year, m.language_id, m.explicit ? 1 : 0, m.explicit ? 'MATURE' : 'ALL', m.description, m.artwork_file]);
      songId = created.insertId;
      await tx.query('INSERT INTO song_genres (song_id, genre_id, is_primary) VALUES (?, ?, 1)', [songId, m.genre_id]);
    }
    // Sound profile → current analysis → mood tags. The song stays non-public until publication.
    if (features) await catalogAdmin.storeAnalysis(tx, songId, features, { activate: false });
    await tx.query("UPDATE artist_uploads SET status = 'APPROVED', song_id = ?, reviewer_user_id = ?, review_note = ?, reviewed_at = NOW() WHERE upload_id = ?",
      [songId, actor.id, note, uploadId]);
    await event(tx, uploadId, actor, 'MODERATOR_APPROVED', 'PENDING_REVIEW', 'APPROVED', note || 'Approved; not yet public.');
    await audit.record(tx, actor, 'UPLOAD_APPROVED', 'artist_upload', uploadId, null, { song_id: songId, artist_id: m.artist_id, corrected: Object.keys(metadata) });
    return { u: m, status: 'APPROVED', songId };
  }, { actorId: actor.id });
  if (result.status === 'REJECTED') {
    await removeQuarantine(result.u);
    return { id: uploadId, status: 'REJECTED' };
  }
  if (publish) return publishUpload(actor, uploadId);
  if (result.u.source === 'ARTIST') {
    await notify.notify(null, result.u.user_id, { kind: 'UPLOAD_APPROVED', title: `“${result.u.title}” was approved`, body: 'It will go live when an Admin publishes it.', link: '/studio/submissions' });
  }
  return { id: uploadId, songId: result.songId, status: 'APPROVED', published: false };
}

async function publishUpload(actor, uploadId) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  requireWritableStorage();
  const u = await one(`SELECT *, (licence_start IS NULL OR licence_start <= CURRENT_DATE) AND (licence_end IS NULL OR licence_end >= CURRENT_DATE) AS licence_active
                         FROM artist_uploads WHERE upload_id = ?`, [uploadId]);
  if (!u) throw ApiError.notFound('Upload');
  if (u.source === 'ARTIST' && u.user_id === actor.id) throw ApiError.forbidden('You cannot publish your own upload.');
  if (u.status !== 'APPROVED' || u.scan_status !== 'CLEAN' || !u.song_id) throw ApiError.conflict('UPLOAD_NOT_APPROVED', 'Approve the recording before publishing it.');
  if (!u.licence_active) throw ApiError.conflict('LICENCE_OUTSIDE_TERM', 'This recording is outside its licence dates and cannot be published now.');
  const analysed = await one('SELECT 1 AS ok FROM audio_features WHERE song_id = ? AND is_current = 1', [u.song_id]);
  if (!analysed) throw new ApiError(409, 'SOUND_PROFILE_REQUIRED', 'Add the sound profile on the song before publishing.');
  const ext = extOf(u);
  const source = quarantinePath(uploadId, ext);
  if (!fs.existsSync(source)) throw new ApiError(410, 'UPLOAD_FILE_MISSING', 'The approved file is missing from storage. Reject this upload and ask for it again.');
  const fileName = finalMediaName(u, ext);
  const destination = path.join(localMedia.dir(), fileName);
  await fs.promises.mkdir(localMedia.dir(), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL).catch((err) => {
    if (err.code === 'EEXIST') throw ApiError.conflict('ALREADY_PUBLISHING', 'This recording is already being published.');
    throw err;
  });
  let previousFile = null;
  try {
    const result = await withTransaction(async (tx) => {
      const locked = await tx.one('SELECT * FROM artist_uploads WHERE upload_id = ? FOR UPDATE', [uploadId]);
      if (!locked || locked.status !== 'APPROVED') throw ApiError.conflict('UPLOAD_NOT_APPROVED', 'The upload changed before publication.');
      if (locked.source === 'ARTIST' && !(await artists.activeArtistAccount(tx, locked.user_id, locked.artist_id))) {
        throw ApiError.conflict('ARTIST_ACCOUNT_INACTIVE', 'The uploader’s account or artist profile is suspended or deactivated.');
      }
      const code = locked.source === 'ADMIN' ? 'LOCAL_MEDIA' : 'ARTIST_UPLOAD';
      const src = await tx.one('SELECT source_id FROM music_sources WHERE code = ? AND is_enabled = 1', [code]);
      if (!src) throw new Error(`${code} media source is missing or disabled.`);
      const prev = await tx.one("SELECT media_id, uri FROM song_media WHERE song_id = ? AND source_id = ? AND media_type = 'USER_LOCAL'", [locked.song_id, src.source_id]);
      previousFile = prev && prev.uri !== fileName ? prev.uri : null;
      await tx.query(
        `INSERT INTO song_media (song_id, source_id, media_type, uri, rights_status, availability, last_checked_at, attribution, priority)
         VALUES (?, ?, 'USER_LOCAL', ?, 'PERMITTED', 'AVAILABLE', NOW(), ?, 5)
         ON DUPLICATE KEY UPDATE uri = VALUES(uri), rights_status = 'PERMITTED', availability = 'AVAILABLE', last_checked_at = NOW(), attribution = VALUES(attribution)`,
        [locked.song_id, src.source_id, fileName, locked.source === 'ADMIN' ? 'LOOP-owned recording.' : 'Uploaded by the verified LOOP artist account.']);
      const media = await tx.one("SELECT media_id FROM song_media WHERE song_id = ? AND source_id = ? AND media_type = 'USER_LOCAL'", [locked.song_id, src.source_id]);
      await tx.query(`UPDATE songs SET status = 'ACTIVE', moderation_state = 'CLEAR', moderation_reason = NULL, moderated_by = ?, moderated_at = NOW(),
                      artwork_file = COALESCE(?, artwork_file) WHERE song_id = ?`, [actor.id, locked.artwork_file, locked.song_id]);
      await tx.query("UPDATE artist_uploads SET status = 'PUBLISHED', media_id = ? WHERE upload_id = ?", [media.media_id, uploadId]);
      await event(tx, uploadId, actor, 'PUBLISHED', 'APPROVED', 'PUBLISHED', 'Live on LOOP.');
      await audit.record(tx, actor, 'UPLOAD_PUBLISHED', 'artist_upload', uploadId, null, { song_id: locked.song_id, media_id: media.media_id });
      if (locked.source === 'ARTIST') {
        await notify.notify(tx, locked.user_id, { kind: 'UPLOAD_PUBLISHED', title: `“${locked.title}” is live on LOOP`, body: 'Listeners can now find it in search and in mood mixes that fit it.', link: `/song/${locked.song_id}`, email: true });
      }
      return { id: uploadId, songId: locked.song_id, mediaId: media.media_id, status: 'PUBLISHED' };
    }, { actorId: actor.id });
    await removeFile(source);
    if (previousFile) await retainFile(previousFile);
    return result;
  } catch (err) {
    await removeFile(destination);
    throw err;
  }
}

/** The uploader withdraws a recording at any stage. A published recording leaves the catalogue at once. */
async function withdraw(user, uploadId, reason = null) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const result = await withTransaction(async (tx) => {
    const u = await tx.one('SELECT * FROM artist_uploads WHERE upload_id = ? AND user_id = ? FOR UPDATE', [uploadId, user.id]);
    if (!u) throw ApiError.notFound('Upload');
    if (['REJECTED', 'TAKEN_DOWN', 'PROCESSING_FAILED'].includes(u.status)) throw ApiError.conflict('UPLOAD_CLOSED', 'This upload is already closed.');
    const note = reason || 'Withdrawn by the artist.';
    let mediaFile = null;
    if (u.status === 'PUBLISHED' && u.song_id) {
      await tx.query(`UPDATE songs SET status = 'HIDDEN', moderation_state = 'WITHDRAWN', moderation_reason = ?, moderated_by = ?, moderated_at = NOW() WHERE song_id = ?`, [note, user.id, u.song_id]);
      const m = u.media_id ? await tx.one('SELECT uri FROM song_media WHERE media_id = ?', [u.media_id]) : null;
      if (u.media_id) await tx.query("UPDATE song_media SET rights_status = 'RESTRICTED', availability = 'UNAVAILABLE' WHERE media_id = ?", [u.media_id]);
      mediaFile = m ? m.uri : null;
    } else if (u.song_id) {
      await tx.query(`UPDATE songs SET status = IF(status = 'ACTIVE', 'HIDDEN', status), moderation_state = 'WITHDRAWN', moderation_reason = ? WHERE song_id = ? AND status <> 'ACTIVE'`, [note, u.song_id]);
    }
    await tx.query("UPDATE artist_uploads SET status = 'TAKEN_DOWN', review_note = ?, next_scan_at = NULL WHERE upload_id = ?", [note, uploadId]);
    await event(tx, uploadId, user, 'ARTIST_WITHDRAWAL', u.status, 'TAKEN_DOWN', note);
    await audit.record(tx, user, 'UPLOAD_WITHDRAWN', 'artist_upload', uploadId, { status: u.status }, { note });
    return { u, mediaFile };
  }, { actorId: user.id });
  if (result.mediaFile) await retainFile(result.mediaFile);
  if (result.u.status !== 'PUBLISHED') await removeQuarantine(result.u);
  return { id: uploadId, status: 'TAKEN_DOWN', playbackBlocked: true };
}

/** Optional cover image for an upload (JPEG/PNG/WebP, ≤ 2 MB), stored before review. */
async function setArtwork(user, uploadId, req, media) {
  if (!safeUploadId(uploadId)) throw ApiError.notFound('Upload');
  const u = await one('SELECT user_id, status, song_id FROM artist_uploads WHERE upload_id = ?', [uploadId]);
  if (!u || u.user_id !== user.id) throw ApiError.notFound('Upload');
  if (!OPEN.includes(u.status)) throw ApiError.conflict('UPLOAD_CLOSED', 'Artwork can only be added before the recording is published.');
  const fileName = await media.storeArtwork(req);
  await query('UPDATE artist_uploads SET artwork_file = ? WHERE upload_id = ?', [fileName, uploadId]);
  return { id: uploadId, artworkUrl: `/api/artwork/${fileName}` };
}

module.exports = {
  createIntent, storeFile, scanUpload, runPipeline, scannerStatus, scannerConfigured, listUploads, uploadDetail, previewFile,
  decide, publishUpload, withdraw, setArtwork, uploadToken, OPEN,
};
