// Every route: authentication → authorisation → input validation → controller.
// Validation schemas are declared next to the route so the contract is visible.
// Roles never come from the request: req.user (role + permissions) is re-read
// from the database for every request by middleware/auth.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers');
const a = require('../controllers/admin');
const h = require('../utils/asyncHandler');
const { requireAuth, optionalAuth, requirePermission, requireRecentAuth, requireSelfOr } = require('../middleware/auth');
const { rules: r, optional: opt, validate: v, idParam } = require('../utils/validate');
const { nodeEnv, rateLimits } = require('../config/env');

const router = express.Router();
const id = idParam('id');
const limitQ = { limit: opt(r.int(1, 50)) };
const pageQ = { page: opt(r.int(1, 10000), 1), pageSize: opt(r.int(1, 100), 25) };
const can = requirePermission;
const test = nodeEnv === 'test';
const big = 2 ** 31;
const uploadId = v({ id: r.str(32, 32, /^[a-f0-9]{32}$/) }, 'params');
const HEX = r.hex();
const UNIT = r.num(0, 1);
const FEATURES = r.object({
  energy: UNIT, valence: UNIT, danceability: UNIT, acousticness: UNIT, instrumentalness: UNIT, speechiness: opt(UNIT, 0.05),
  tempo_bpm: r.num(40, 220), loudness_db: opt(r.num(-60, 0), -8), key: opt(r.int(0, 11), 0), mode: opt(r.int(0, 1), 1),
});
const ISRC = r.str(12, 12, /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/, 'must be a 12-character ISRC like INABC2600001');
const PASSWORD = r.str(8, 72, /^(?=.*[A-Za-z])(?=.*\d).+$/, 'needs at least one letter and one number');
const REASON = r.str(3, 300);

// Failed sign-ins per visitor per 15 minutes (successful ones are not counted), plus a per-account
// limiter keyed on visitor + login name, so one visitor can never exhaust anyone else's attempts.
const ipKey = (req) => req.ip;
const authFailures = rateLimit({
  windowMs: 15 * 60 * 1000, limit: test ? 1000 : rateLimits.authFailuresPer15Min, skipSuccessfulRequests: true,
  standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts from your network. Wait 15 minutes and try again.' } },
});
const perAccount = rateLimit({
  windowMs: 15 * 60 * 1000, limit: test ? 1000 : 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String((req.body && req.body.login) || '').toLowerCase().slice(0, 120)}`,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts for this account. Wait 15 minutes, or reset your password.' } },
});
// Successful registrations ARE counted: one network cannot create accounts in bulk.
const registrations = rateLimit({
  windowMs: 60 * 60 * 1000, limit: test ? 1000 : rateLimits.registrationsPerHour, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many new accounts from your network. Try again in an hour.' } },
});
const recovery = rateLimit({
  windowMs: 15 * 60 * 1000, limit: test ? 1000 : 10, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a few minutes and try again.' } },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, limit: test ? 5000 : rateLimits.writesPerMinute, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : req.ip),
  message: { error: { code: 'RATE_LIMITED', message: 'Slow down a little and try again.' } },
});

// ---------------------------------------------------------------- public: account access
router.post('/auth/register', registrations, v({
  username: r.str(3, 30, /^[a-z0-9_]+$/, 'may use lowercase letters, digits and _ only'),
  email: r.email(),
  password: PASSWORD,
  displayName: r.str(1, 60),
  acceptTerms: r.bool(),
}), h(c.auth.register));
router.post('/auth/login', authFailures, perAccount, v({ login: r.str(3, 120), password: r.str(1, 72) }), h(c.auth.login));
router.get('/auth/session', optionalAuth, h(c.auth.session));
router.post('/auth/password-reset/request', recovery, v({ login: r.str(3, 120) }), h(c.auth.requestReset));
router.post('/auth/password-reset/confirm', recovery, v({ token: r.str(20, 100), newPassword: PASSWORD }), h(c.auth.confirmReset));
router.post('/auth/verify-email', recovery, v({ token: r.str(20, 100) }), h(c.auth.verifyEmail));
router.get('/platform', h(c.catalog.platform));

// The upload file itself may be sent straight to the API host, authorised by the upload token.
router.put('/uploads/:id/content', recovery, uploadId, h(c.uploads.content));

// ---------------------------------------------------------------- catalogue & reference data
const listQ = {
  genreId: opt(r.int(1, 65535)), moodId: opt(r.int(1, 65535)), languageId: opt(r.int(0, 65535)),
  page: opt(r.int(1, 1000), 1), pageSize: opt(r.int(1, 60), 24), sort: opt(r.oneOf(['popular', 'newest', 'title']), 'popular'),
};
router.get('/moods', optionalAuth, h(c.catalog.moods));
router.get('/contexts', optionalAuth, h(c.catalog.contexts));
router.get('/genres', optionalAuth, h(c.catalog.genres));
router.get('/languages', optionalAuth, h(c.catalog.languages));
router.get('/songs', optionalAuth, v(listQ, 'query'), h(c.catalog.songs));
router.get('/songs/:id', optionalAuth, id, h(c.catalog.song));
router.get('/artists/:id', optionalAuth, id, h(c.catalog.artist));
router.get('/albums/:id', optionalAuth, id, h(c.catalog.album));
router.get('/picks', optionalAuth, h(c.catalog.picks));
router.get('/search/suggest', optionalAuth, v({ q: r.str(2, 80) }, 'query'), h(c.catalog.searchSuggest));
router.get('/search', optionalAuth, v({ q: r.str(1, 80) }, 'query'), h(c.catalog.search));
router.get('/artwork/:file', v({ file: r.str(5, 121, /^art_[a-f0-9]{24}\.(jpg|png|webp)$/) }, 'params'), h(c.media.artwork));
router.get('/shared/playlists/:token', optionalAuth, v({ token: r.str(22, 22, /^[A-Za-z0-9_-]{22}$/) }, 'params'), h(c.playlists.shared));
// Live mood interpretation is a read: cheap, cached in memory, never counted against the write limit.
router.get('/recommendations/parse', optionalAuth, v({ text: r.str(1, 280) }, 'query'), h(c.rec.parse));

// ---------------------------------------------------------------- everything below needs a session
router.use(requireAuth);
router.use((req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)));

router.get('/auth/me', h(c.auth.me));
router.post('/auth/logout', h(c.auth.logout));
router.post('/auth/logout-all', h(c.auth.logoutAll));
router.post('/auth/reauth', v({ password: r.str(1, 72) }), h(c.auth.reauth));

// ---------------------------------------------------------------- account, privacy & notifications
const idList = (max) => r.arrayOf(r.int(1, big), max);
router.get('/me/sessions', h(c.me.sessions));
router.delete('/me/sessions/:sessionId', v({ sessionId: r.str(16, 16, /^[0-9a-f]{16}$/) }, 'params'), h(c.me.revokeSession));
router.post('/me/password', v({ currentPassword: r.str(1, 72), newPassword: PASSWORD }), h(c.me.changePassword));
router.post('/me/verify-email', h(c.me.sendVerification));
router.delete('/me', v({ password: r.str(1, 72), confirm: r.oneOf(['DELETE']) }), h(c.me.deleteAccount));
router.get('/me/preferences', h(c.me.preferenceOptions));
router.put('/me/preferences', v({
  languageIds: r.arrayOf(r.int(1, 65535), 5, 1),
  regionCode: opt(r.str(2, 6, /^[A-Z]{2}(-[A-Z]{2,3})?$/)),
  genreIds: opt(idList(6), []),
  artistIds: opt(idList(8), []),
  moodIds: opt(idList(5), []),
  contextCodes: opt(r.arrayOf(r.str(2, 20, /^[A-Z_]+$/), 4), []),
  listeningHabit: opt(r.oneOf(['BACKGROUND', 'ACTIVE', 'MIXED'])),
  contentFilter: opt(r.oneOf(['OFF', 'NO_EXPLICIT', 'FAMILY'])),
}), h(c.me.savePreferences));
router.patch('/me/settings', v({ displayName: opt(r.str(1, 60)), contentFilter: opt(r.oneOf(['OFF', 'NO_EXPLICIT', 'FAMILY'])) }), h(c.me.updateSettings));
router.get('/me/notifications', h(c.me.notifications));
router.post('/me/notifications/read', v({ ids: opt(r.arrayOf(r.int(1, 2 ** 53), 100)) }), h(c.me.readNotifications));
router.get('/me/privacy', h(c.me.privacy));
router.delete('/me/history/search', h(c.me.clearSearch));
router.delete('/me/history/listening', h(c.me.clearListening));
router.get('/me/export', h(c.me.exportData));
router.get('/me/reports', h(c.reports.mine));
router.post('/reports', v({
  targetType: r.oneOf(['SONG', 'ARTIST', 'ALBUM', 'USER']), targetId: r.int(1, big),
  reason: r.oneOf(['COPYRIGHT', 'IMPERSONATION', 'EXPLICIT_CONTENT', 'MISLABELLED', 'SAFETY', 'SPAM', 'HARASSMENT', 'OTHER']),
  details: r.str(10, 2000), evidenceRef: opt(r.str(9, 500, /^https:\/\//i)),
}), h(c.reports.create));

// ---------------------------------------------------------------- mood recommendations (the core journey)
router.post('/recommendations/mood', v({
  moodIds: opt(r.arrayOf(r.int(1, 65535), 4), []),
  moodWeights: opt(r.arrayOf(r.object({ moodId: r.int(1, 65535), weight: r.decimal(0.01, 100, 2) }), 4, 1)),
  text: opt(r.str(2, 280)),
  contextCode: opt(r.str(2, 20, /^[A-Z_]+$/)),
  limit: opt(r.int(1, 50), 20),
}), h(c.rec.mood));
router.get('/recommendations/for-you', v(limitQ, 'query'), h(c.rec.forYou));
router.get('/recommendations/similar', v({ seed: opt(r.int(1, big)), ...limitQ }, 'query'), h(c.rec.similar));
router.get('/recommendations/batches/:id', id, h(c.rec.batch));
router.get('/recommendations/history', v(limitQ, 'query'), h(c.rec.history));

// ---------------------------------------------------------------- feedback
router.put('/songs/:id/rating', id, v({ rating: r.int(1, 5) }), h(c.feedback.rate));
router.delete('/songs/:id/rating', id, h(c.feedback.unrate));
router.put('/songs/:id/like', id, v({ liked: r.bool() }), h(c.feedback.like));
router.get('/likes', h(c.feedback.liked));
router.put('/songs/:id/dismiss', id, v({ batchId: opt(r.int(1, 2 ** 53)) }), h(c.feedback.dismiss));
router.delete('/songs/:id/dismiss', id, h(c.feedback.undismiss));
router.get('/me/dismissals', h(c.feedback.dismissed));

// ---------------------------------------------------------------- library
router.get('/playlists', h(c.playlists.list));
router.post('/playlists', v({ name: r.str(1, 80), description: opt(r.str(0, 255)), songIds: opt(r.arrayOf(r.int(1, big), 200), []) }), h(c.playlists.create));
router.post('/playlists/from-batch', v({ batchId: r.int(1, 2 ** 53), name: r.str(1, 80), description: opt(r.str(0, 255)) }), h(c.playlists.saveBatch));
router.get('/playlists/:id', id, h(c.playlists.detail));
router.patch('/playlists/:id', id, v({ name: opt(r.str(1, 80)), description: opt(r.str(0, 255)) }), h(c.playlists.update));
router.delete('/playlists/:id', id, h(c.playlists.remove));
router.post('/playlists/:id/songs', id, v({ songId: r.int(1, big) }), h(c.playlists.addSong));
router.put('/playlists/:id/order', id, v({ songIds: r.arrayOf(r.int(1, big), 2000, 1) }), h(c.playlists.reorder));
router.put('/playlists/:id/share', id, v({ enabled: r.bool() }), h(c.playlists.share));
router.delete('/playlists/:id/songs/:songId', v({ id: r.int(1, big), songId: r.int(1, big) }, 'params'), h(c.playlists.removeSong));

// ---------------------------------------------------------------- playback (LOOP-owned audio only) & history
const ORIGIN = r.oneOf(['HOME', 'MOOD', 'SEARCH', 'PLAYLIST', 'LIBRARY']);
router.post('/playback/start', v({ songId: r.int(1, big), origin: opt(ORIGIN, 'MOOD'), batchId: opt(r.int(1, 2 ** 53)) }), h(c.playback.start));
router.post('/playback/:playId/finish', v({ playId: r.int(1, 2 ** 53) }, 'params'), v({
  listenedSec: r.int(0, 1800), positionSec: opt(r.int(0, 1800)),
}), h(c.playback.finish));
router.get('/history', v(limitQ, 'query'), h(c.playback.recent));
router.get('/media/:id', id, h(c.media.stream));

// ---------------------------------------------------------------- artist access & studio
const UPLOAD_FIELDS = {
  artistId: r.int(1, big), title: r.str(1, 150), versionLabel: opt(r.str(0, 40), ''),
  genreId: r.int(1, 65535), languageId: opt(r.int(1, 65535)), durationSec: r.int(30, 1800),
  releaseYear: r.int(1900, 2100), explicit: opt(r.bool(), false), description: opt(r.str(0, 500)), fileSize: r.int(1, 52428800),
  mimeType: r.str(1, 100), compositionRights: r.oneOf(['OWNED', 'LICENSED', 'PUBLIC_DOMAIN']),
  recordingRights: r.oneOf(['OWNED', 'LICENSED', 'PUBLIC_DOMAIN']),
  rightsEvidenceRef: opt(r.str(9, 500, /^https:\/\//i)),
  territories: opt(r.arrayOf(r.str(2, 10, /^(WORLDWIDE|[A-Z]{2})$/), 50, 1), ['WORLDWIDE']),
  licenceStart: opt(r.date()), licenceEnd: opt(r.date()), royaltySharePct: opt(r.decimal(0, 100, 2), 0),
  royaltyCurrency: opt(r.str(3, 3, /^[A-Z]{3}$/), 'INR'), rightsAccepted: r.bool(),
};
router.get('/artist/me', h(c.artist.me));
router.get('/artist/stats', can('artist.studio'), h(c.artist.stats));
router.post('/artist/applications', v({
  stageName: r.str(1, 100), artistType: opt(r.oneOf(['SOLO', 'GROUP', 'COMPOSER', 'ORCHESTRA']), 'SOLO'),
  countryCode: opt(r.str(2, 2, /^[A-Z]{2}$/), 'IN'), bio: opt(r.str(0, 400)),
  websiteUrl: opt(r.str(9, 255, /^https:\/\//i)), proofUrl: opt(r.str(9, 500, /^https:\/\//i)),
}), h(c.artist.apply));
router.post('/artist/applications/:id/withdraw', id, h(c.artist.withdrawApplication));
router.patch('/artist/profiles/:id', can('artist.studio'), id, v({
  name: opt(r.str(1, 100)), nameReason: opt(r.str(0, 300)), artistType: opt(r.oneOf(['SOLO', 'GROUP', 'COMPOSER', 'ORCHESTRA'])),
  bio: opt(r.str(0, 400)), formedYear: opt(r.int(1900, 2100)),
}), h(c.artist.updateProfile));
router.post('/artist/uploads', can('artist.upload'), v(UPLOAD_FIELDS), h(c.artist.createUpload));
router.get('/artist/uploads/:id', can('artist.upload'), uploadId, h(c.artist.upload));
router.put('/artist/uploads/:id/content', can('artist.upload'), uploadId, h(c.uploads.content));
router.put('/artist/uploads/:id/artwork', can('artist.upload'), uploadId, h(c.artist.artwork));
router.post('/artist/uploads/:id/withdraw', can('artist.upload'), uploadId, v({ reason: opt(r.str(0, 300)) }), h(c.artist.withdraw));

// ---------------------------------------------------------------- admin console
const A = express.Router();
const re = requireRecentAuth;   // step-up: password re-entered within the last few minutes
const stateQ = opt(r.oneOf(['PUBLISHED', 'NEEDS_PROFILE', 'HIDDEN', 'SUSPENDED', 'TAKEN_DOWN', 'WITHDRAWN', 'MERGED']));

A.get('/overview', can('health.view'), h(a.overview));
A.get('/badges', can('health.view'), h(a.badges));
A.get('/permissions', can('health.view'), h(a.permissionMatrix));
A.get('/health', can('health.view'), h(a.health));
A.get('/references', can('catalog.write'), h(a.references));
A.get('/audit', can('audit.view'), v({ ...pageQ, actor: opt(r.str(1, 60)), action: opt(r.str(1, 40, /^[A-Z_]+$/)), entityType: opt(r.str(1, 30, /^[a-z_]+$/)),
  entityId: opt(r.str(1, 40)), from: opt(r.date()), to: opt(r.date()) }, 'query'), h(a.audit));
A.get('/audit.csv', can('audit.view'), v({ actor: opt(r.str(1, 60)), action: opt(r.str(1, 40, /^[A-Z_]+$/)), entityType: opt(r.str(1, 30, /^[a-z_]+$/)),
  entityId: opt(r.str(1, 40)), from: opt(r.date()), to: opt(r.date()) }, 'query'), h(a.auditCsv));

// users
A.get('/users', can('users.manage'), v({ ...pageQ, q: opt(r.str(0, 80), ''), role: opt(r.oneOf(['LISTENER', 'ARTIST', 'ADMIN'])),
  status: opt(r.oneOf(['active', 'deactivated', 'locked', 'anonymised', 'password_change'])), sort: opt(r.oneOf(['newest', 'oldest', 'name', 'last_login'])) }, 'query'), h(a.users));
A.get('/users/:id', can('users.manage'), id, h(a.user));
A.post('/users/:id/active', can('users.manage'), id, re, v({ active: r.bool(), reason: opt(REASON) }), h(a.setActive));
A.post('/users/:id/lock', can('users.manage'), id, re, v({ locked: r.bool(), reason: opt(REASON) }), h(a.setLock));
A.post('/users/:id/role', can('users.manage'), id, re, v({ role: r.oneOf(['LISTENER', 'ARTIST', 'ADMIN']) }), h(a.setRole));
A.post('/users/:id/reset-link', can('users.manage'), id, re, h(a.resetLink));
A.post('/users/:id/sign-out', can('users.manage'), id, re, h(a.signOut));
A.post('/users/:id/anonymise', can('users.manage'), id, re, v({ reason: REASON, confirm: r.oneOf(['ANONYMISE']) }), h(a.anonymise));
A.get('/security/published-passwords', can('users.manage'), h(a.publishedPasswords));

// artists, applications, name changes
A.get('/artists', can('catalog.write'), v({ ...pageQ, q: opt(r.str(0, 80), ''), status: opt(r.oneOf(['linked', 'suspended', 'catalogue', 'duplicates'])) }, 'query'), h(a.artists));
A.get('/artists/:id', can('catalog.write'), id, h(a.artist));
A.post('/artists', can('catalog.write'), v({
  name: r.str(1, 100), disambiguation: opt(r.str(0, 80), ''), type: opt(r.oneOf(['SOLO', 'GROUP', 'COMPOSER', 'ORCHESTRA']), 'SOLO'),
  countryCode: opt(r.str(2, 2, /^[A-Z]{2}$/), 'IN'), regionCode: opt(r.str(2, 6, /^[A-Z]{2}(-[A-Z]{2,3})?$/)),
  languageId: opt(r.int(1, 65535)), formedYear: opt(r.int(1900, 2100)), bio: opt(r.str(0, 400)), aliases: opt(r.arrayOf(r.str(1, 100), 10), []),
}), h(a.createArtist));
A.patch('/artists/:id', can('catalog.write'), id, v({
  name: opt(r.str(1, 100)), disambiguation: opt(r.str(0, 80)), type: opt(r.oneOf(['SOLO', 'GROUP', 'COMPOSER', 'ORCHESTRA'])),
  countryCode: opt(r.str(2, 2, /^[A-Z]{2}$/)), regionCode: opt(r.str(2, 6, /^[A-Z]{2}(-[A-Z]{2,3})?$/)), languageId: opt(r.int(1, 65535)),
  formedYear: opt(r.int(1900, 2100)), bio: opt(r.str(0, 400)),
}), h(a.updateArtist));
A.put('/artists/:id/aliases', can('catalog.write'), id, v({ aliases: r.arrayOf(r.str(1, 100), 20) }), h(a.setAliases));
A.post('/artists/:id/suspend', can('artist.review'), id, re, v({ reason: REASON, hideSongs: opt(r.bool(), true) }), h(a.suspendArtist));
A.post('/artists/:id/reinstate', can('artist.review'), id, re, v({ note: opt(r.str(0, 300)) }), h(a.reinstateArtist));
A.get('/artist-applications', can('artist.review'), v({ ...pageQ, q: opt(r.str(0, 80), ''),
  status: opt(r.oneOf(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'ALL']), 'PENDING') }, 'query'), h(a.applications));
A.post('/artist-applications/:id/decision', can('artist.review'), id, v({ action: r.oneOf(['APPROVE', 'REJECT']), note: opt(r.str(0, 500)),
  stageName: opt(r.str(1, 100)), linkArtistId: opt(r.int(1, big)) }), h(a.decideApplication));
A.get('/name-changes', can('artist.review'), v({ ...pageQ, status: opt(r.oneOf(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']), 'PENDING') }, 'query'), h(a.nameChanges));
A.post('/name-changes/:id/decision', can('artist.review'), id, v({ action: r.oneOf(['APPROVE', 'REJECT']), note: opt(r.str(0, 500)) }), h(a.decideNameChange));

// songs
A.get('/songs', can('catalog.write'), v({ ...pageQ, q: opt(r.str(0, 80), ''), state: stateQ, artistId: opt(r.int(1, big)), albumId: opt(r.int(1, big)),
  genreId: opt(r.int(1, 65535)), playable: opt(r.oneOf(['yes', 'no'])), sort: opt(r.oneOf(['newest', 'oldest', 'title', 'artist', 'popular'])) }, 'query'), h(a.songs));
A.get('/songs/:id', can('catalog.write'), id, h(a.song));
A.post('/songs', can('catalog.write'), v({
  title: r.str(1, 150), versionLabel: opt(r.str(0, 40), ''), artistId: r.int(1, big), albumId: opt(r.int(1, big)),
  trackNumber: opt(r.int(1, 99)), genreId: r.int(1, 65535), durationSec: r.int(30, 1800), releaseYear: r.int(1900, 2100),
  languageId: opt(r.int(1, 65535)), isrc: opt(ISRC), description: opt(r.str(0, 500)),
  explicit: opt(r.bool(), false), contentRating: opt(r.oneOf(['ALL', 'TEEN', 'MATURE']), 'ALL'), popularity: opt(r.int(0, 100), 50),
  features: opt(FEATURES), publish: opt(r.bool(), true),
}), h(a.createSong));
A.patch('/songs/:id', can('catalog.write'), id, v({
  title: opt(r.str(1, 150)), versionLabel: opt(r.str(0, 40)), artistId: opt(r.int(1, big)), albumId: opt(r.int(1, big)), trackNumber: opt(r.int(1, 99)),
  durationSec: opt(r.int(30, 1800)), releaseYear: opt(r.int(1900, 2100)), languageId: opt(r.int(1, 65535)), isrc: opt(ISRC),
  explicit: opt(r.bool()), contentRating: opt(r.oneOf(['ALL', 'TEEN', 'MATURE'])), popularity: opt(r.int(0, 100)), description: opt(r.str(0, 500)),
  genreId: opt(r.int(1, 65535)), features: opt(FEATURES),
}), h(a.updateSong));
A.post('/songs/:id/state', can('catalog.write'), id, v({ action: r.oneOf(['HIDE', 'UNHIDE', 'SUSPEND', 'TAKE_DOWN', 'RESTORE']), reason: opt(r.str(0, 500)) }), h(a.songState));
A.delete('/songs/:id', can('catalog.write'), id, re, h(a.deleteSong));
A.post('/songs/:id/merge', can('catalog.write'), id, re, v({ intoSongId: r.int(1, big) }), h(a.mergeSong));
A.put('/songs/:id/moods/:moodId', can('catalog.write'), v({ id: r.int(1, big), moodId: r.int(1, 65535) }, 'params'),
  v({ action: r.oneOf(['ADD', 'REMOVE']), confidence: opt(r.num(0.05, 1)), note: opt(r.str(0, 200)) }), h(a.curateMood));
A.delete('/songs/:id/moods/:moodId', can('catalog.write'), v({ id: r.int(1, big), moodId: r.int(1, 65535) }, 'params'), h(a.clearCuration));
A.put('/songs/:id/artwork', can('catalog.write'), id, h(a.songArtwork));

// albums
A.get('/albums', can('catalog.write'), v({ ...pageQ, q: opt(r.str(0, 80), ''), status: opt(r.oneOf(['PUBLISHED', 'UNPUBLISHED'])), artistId: opt(r.int(1, big)) }, 'query'), h(a.albums));
A.get('/albums/:id', can('catalog.write'), id, h(a.album));
const ALBUM_TYPES = ['ALBUM', 'EP', 'SINGLE', 'SOUNDTRACK', 'COMPILATION'];
A.post('/albums', can('catalog.write'), v({
  title: r.str(1, 150), albumType: opt(r.oneOf(ALBUM_TYPES), 'ALBUM'), releaseYear: r.int(1900, 2100), languageId: opt(r.int(1, 65535)),
  coverColor1: HEX, coverColor2: HEX, artistIds: r.arrayOf(r.int(1, big), 6, 1), description: opt(r.str(0, 500)), status: opt(r.oneOf(['PUBLISHED', 'UNPUBLISHED'])),
}), h(a.createAlbum));
A.patch('/albums/:id', can('catalog.write'), id, v({
  title: opt(r.str(1, 150)), albumType: opt(r.oneOf(ALBUM_TYPES)), releaseYear: opt(r.int(1900, 2100)), languageId: opt(r.int(1, 65535)),
  coverColor1: opt(HEX), coverColor2: opt(HEX), artistIds: opt(r.arrayOf(r.int(1, big), 6, 1)), description: opt(r.str(0, 500)),
  status: opt(r.oneOf(['PUBLISHED', 'UNPUBLISHED'])),
}), h(a.updateAlbum));
A.put('/albums/:id/tracks', can('catalog.write'), id, v({ songIds: r.arrayOf(r.int(1, big), 200) }), h(a.setTracks));
A.put('/albums/:id/artwork', can('catalog.write'), id, h(a.albumArtwork));
A.delete('/albums/:id', can('catalog.write'), id, re, h(a.deleteAlbum));

// uploads & audio
A.get('/uploads', can('artist.review'), v({ ...pageQ, q: opt(r.str(0, 80), ''), source: opt(r.oneOf(['ARTIST', 'ADMIN'])),
  status: opt(r.oneOf(['UPLOADING', 'QUARANTINED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED', 'TAKEN_DOWN', 'PROCESSING_FAILED', 'ALL']), 'PENDING_REVIEW') }, 'query'), h(a.uploads));
A.get('/uploads/:id', can('artist.review'), uploadId, h(a.upload));
A.get('/uploads/:id/audio', can('artist.review'), uploadId, h(a.uploadAudio));
A.post('/uploads', can('media.manage'), v({ ...UPLOAD_FIELDS, targetSongId: opt(r.int(1, big)) }), h(a.createUpload));
A.post('/uploads/:id/scan', can('artist.review'), uploadId, h(a.scanUpload));
A.post('/uploads/:id/decision', can('artist.review'), uploadId, v({
  action: r.oneOf(['APPROVE', 'REJECT']), note: opt(r.str(0, 500)), publish: opt(r.bool(), false), features: opt(FEATURES),
  metadata: opt(r.object({ title: opt(r.str(1, 150)), versionLabel: opt(r.str(0, 40)), genreId: opt(r.int(1, 65535)), languageId: opt(r.int(1, 65535)),
    releaseYear: opt(r.int(1900, 2100)), explicit: opt(r.bool()), description: opt(r.str(0, 500)) }), {}),
}), h(a.decideUpload));
A.post('/uploads/:id/publish', can('artist.review'), uploadId, h(a.publishUpload));
A.get('/media', can('media.manage'), h(a.media));
A.post('/media/check', can('media.manage'), h(a.checkMedia));
A.get('/media/:id/audio', can('media.manage'), id, h(a.mediaAudio));
A.post('/songs/:id/media', can('media.manage'), id, v({
  fileName: r.str(1, 121, /^[A-Za-z0-9][A-Za-z0-9._-]*$/), rights: opt(r.oneOf(['PERMITTED', 'ATTRIBUTION_REQUIRED']), 'PERMITTED'), attribution: opt(r.str(0, 200), null),
}), h(a.registerMedia));
A.delete('/songs/:id/media/:mediaId', can('media.manage'), v({ id: r.int(1, big), mediaId: r.int(1, big) }, 'params'), re, h(a.removeMedia));

// reports
A.get('/reports', can('reports.manage'), v({ ...pageQ, status: opt(r.oneOf(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'ACTIVE', 'ALL']), 'ACTIVE'),
  targetType: opt(r.oneOf(['SONG', 'ARTIST', 'ALBUM', 'USER'])),
  reason: opt(r.oneOf(['COPYRIGHT', 'IMPERSONATION', 'EXPLICIT_CONTENT', 'MISLABELLED', 'SAFETY', 'SPAM', 'HARASSMENT', 'OTHER'])) }, 'query'), h(a.reports));
A.get('/reports/:id', can('reports.manage'), id, h(a.report));
A.post('/reports/:id/notes', can('reports.manage'), id, v({ body: r.str(1, 1000) }), h(a.reportNote));
A.post('/reports/:id/assign', can('reports.manage'), id, h(a.assignReport));
A.post('/reports/:id/resolve', can('reports.manage'), id, v({ outcome: r.oneOf(['RESOLVED', 'DISMISSED']),
  action: opt(r.oneOf(['NONE', 'HIDE', 'SUSPEND', 'TAKE_DOWN', 'MARK_EXPLICIT', 'SUSPEND_ARTIST', 'UNPUBLISH_ALBUM', 'DEACTIVATE_USER', 'LOCK_USER']), 'NONE'),
  note: r.str(3, 500) }), h(a.resolveReport));

// taxonomy, settings, recommender, editorial, duplicates
A.get('/taxonomy', can('catalog.write'), h(a.taxonomy));
A.patch('/moods/:id', can('catalog.write'), id, v({ name: opt(r.str(1, 30)), emoji: opt(r.str(1, 8)), color: opt(HEX), description: opt(r.str(1, 200)),
  energy: opt(UNIT), valence: opt(UNIT), danceability: opt(UNIT), acousticness: opt(UNIT), instrumentalness: opt(UNIT),
  tempoMin: opt(r.num(40, 220)), tempoMax: opt(r.num(40, 220)) }), h(a.updateMood));
A.post('/mood-phrases', can('catalog.write'), v({ phrase: r.str(2, 60), moodId: r.int(1, 65535), weight: r.decimal(0.1, 1, 2) }), h(a.addKeyword));
A.delete('/mood-phrases/:id', can('catalog.write'), id, h(a.removeKeyword));
const GENRE = v({ name: r.str(1, 40), parentId: opt(r.int(1, 65535)), color: HEX, description: opt(r.str(0, 200)) });
A.post('/genres', can('catalog.write'), GENRE, h(a.createGenre));
A.patch('/genres/:id', can('catalog.write'), id, GENRE, h(a.updateGenre));
A.delete('/genres/:id', can('catalog.write'), id, h(a.deleteGenre));
const LANGUAGE = v({ iso: r.str(2, 3, /^[a-z]{2,3}$/), name: r.str(1, 40), nativeName: r.str(1, 40), script: r.str(1, 30) });
A.post('/languages', can('catalog.write'), LANGUAGE, h(a.createLanguage));
A.patch('/languages/:id', can('catalog.write'), id, LANGUAGE, h(a.updateLanguage));
A.patch('/contexts/:id', can('catalog.write'), id, v({ name: opt(r.str(1, 40)), emoji: opt(r.str(1, 8)), description: opt(r.str(1, 200)),
  phrases: opt(r.arrayOf(r.str(2, 60), 60)) }), h(a.updateContext));
A.get('/settings', can('settings.manage'), h(a.settings));
A.put('/settings', can('settings.manage'), re, v({ changes: r.object({
  registration_open: opt(r.bool()), maintenance_message: opt(r.str(0, 300)), artist_applications_open: opt(r.bool()),
  upload_max_mb: opt(r.int(1, 50)), upload_quota_mb: opt(r.int(10, 10000)), open_uploads_per_artist: opt(r.int(1, 50)),
  application_cooldown_days: opt(r.int(0, 365)), search_history_days: opt(r.int(1, 3650)), unsaved_mix_days: opt(r.int(1, 3650)),
}) }), h(a.updateSettings));
A.get('/recommender', can('models.tune'), h(a.weights));
A.put('/recommender', can('models.tune'), re, v({ changes: r.object({
  w_mood: opt(r.num(0, 1)), w_audio: opt(r.num(0, 1)), w_preference: opt(r.num(0, 1)), w_recency: opt(r.num(0, 1)),
  w_trend: opt(r.num(0, 1)), w_context: opt(r.num(0, 1)), w_regional: opt(r.num(0, 1)), w_exploration: opt(r.num(0, 1)),
}) }), h(a.updateWeights));
A.get('/picks', can('settings.manage'), h(a.picks));
const PICK = v({ songId: r.int(1, big), headline: r.str(1, 80), note: opt(r.str(0, 200)), sortOrder: opt(r.int(0, 999), 0),
  startsAt: opt(r.str(10, 19, /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)), endsAt: opt(r.str(10, 19, /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)) });
A.post('/picks', can('settings.manage'), PICK, h(a.createPick));
A.patch('/picks/:id', can('settings.manage'), id, PICK, h(a.updatePick));
A.delete('/picks/:id', can('settings.manage'), id, h(a.deletePick));
A.get('/duplicates', can('catalog.write'), h(a.duplicates));

router.use('/admin', A);

// Kept for API clients: another user's personal mix needs users.manage.
router.get('/users/:id/recommendations', id, requireSelfOr('users.manage'), v(limitQ, 'query'), h(c.rec.forUser));

module.exports = router;
