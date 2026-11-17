// Admin console controllers. Every route that reaches these already passed requireAuth and a
// named permission (routes/index.js); privilege and destructive actions also passed step-up auth.
const accounts = require('../services/accountService');
const artists = require('../services/artistService');
const catalog = require('../services/catalogAdminService');
const platform = require('../services/platformAdminService');
const uploads = require('../services/uploadService');
const reports = require('../services/reportService');
const settings = require('../services/settingsService');
const audit = require('../services/auditService');
const media = require('../services/mediaService');
const healthSvc = require('../services/healthService');
const { query } = require('../config/db');
const { localMedia } = require('../providers');
const { sendFile } = require('./index');

const b = (req) => (req.valid && req.valid.body) || {};
const q = (req) => (req.valid && req.valid.query) || {};
const p = (req) => (req.valid && req.valid.params) || {};
const me = (req) => ({ id: req.user.id, username: req.user.username });
const json = (fn) => async (req, res) => res.json(await fn(req));
const created = (fn) => async (req, res) => res.status(201).json(await fn(req));

async function stream(res, f) {
  res.set('Cache-Control', 'private, no-store');
  res.type(f.type);
  await sendFile(res, f.full);
}

async function permissionMatrix() {
  const [roles, permissions, assignments] = await Promise.all([
    query('SELECT role_id AS id, code, name FROM roles ORDER BY role_id'),
    query('SELECT permission_code AS code, description FROM permissions ORDER BY permission_code'),
    query('SELECT role_id AS roleId, permission_code AS permission FROM role_permissions ORDER BY role_id, permission_code'),
  ]);
  const byRole = new Map(roles.map((role) => [role.id, []]));
  for (const row of assignments) byRole.get(row.roleId)?.push(row.permission);
  return { permissions, roles: roles.map((role) => ({ ...role, permissions: byRole.get(role.id) || [] })) };
}

module.exports = {
  overview: json(() => platform.overview()),
  badges: json(() => platform.badges()),
  permissionMatrix: json(() => permissionMatrix()),
  health: json(async (req) => ({ ...(await healthSvc.health()), mediaStorage: localMedia.check(), scanner: await uploads.scannerStatus(),
    clientIp: { seen: req.ip, viaProxies: (req.ips || []).length } })),
  references: json(() => platform.references()),
  audit: json((req) => audit.list(q(req))),
  auditCsv: async (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="loop-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await audit.csv(q(req)));
  },

  users: json((req) => accounts.listUsers(q(req))),
  user: json((req) => accounts.userDetail(p(req).id)),
  setActive: json((req) => accounts.setActive(me(req), p(req).id, b(req).active, b(req).reason)),
  setLock: json((req) => accounts.setLock(me(req), p(req).id, b(req).locked, b(req).reason)),
  setRole: json((req) => accounts.changeRole(me(req), p(req).id, b(req).role)),
  resetLink: created((req) => accounts.adminResetLink(me(req), p(req).id)),
  signOut: json((req) => accounts.signOutEverywhere(me(req), p(req).id)),
  anonymise: json((req) => accounts.anonymise(me(req), p(req).id, b(req).reason)),
  publishedPasswords: json(() => accounts.publishedPasswordAccounts()),

  artists: json((req) => catalog.listArtists(q(req))),
  artist: json((req) => catalog.artistDetail(p(req).id)),
  createArtist: created((req) => catalog.createArtist(me(req), b(req))),
  updateArtist: json((req) => catalog.updateArtist(me(req), p(req).id, b(req))),
  setAliases: json((req) => catalog.setAliases(me(req), p(req).id, b(req).aliases)),
  suspendArtist: json((req) => artists.suspendArtist(me(req), p(req).id, b(req))),
  reinstateArtist: json((req) => artists.reinstateArtist(me(req), p(req).id, b(req))),
  applications: json((req) => artists.listApplications(q(req))),
  decideApplication: json((req) => artists.decideApplication(me(req), p(req).id, b(req))),
  nameChanges: json((req) => artists.listNameChanges(q(req))),
  decideNameChange: json((req) => artists.decideNameChange(me(req), p(req).id, b(req))),

  songs: json((req) => catalog.listSongs(q(req))),
  song: json((req) => catalog.songDetail(p(req).id)),
  createSong: created((req) => catalog.createSong(me(req), b(req))),
  updateSong: json((req) => catalog.updateSong(me(req), p(req).id, b(req))),
  songState: json((req) => catalog.changeState(me(req), p(req).id, b(req))),
  deleteSong: json((req) => catalog.deleteSong(me(req), p(req).id)),
  mergeSong: json((req) => catalog.mergeSong(me(req), p(req).id, b(req).intoSongId)),
  curateMood: json((req) => catalog.curateMood(me(req), p(req).id, p(req).moodId, b(req))),
  clearCuration: json((req) => catalog.clearCuration(me(req), p(req).id, p(req).moodId)),
  songArtwork: json(async (req) => catalog.setArtwork(me(req), 'song', p(req).id, await media.storeArtwork(req))),

  albums: json((req) => catalog.listAlbums(q(req))),
  album: json((req) => catalog.albumDetail(p(req).id)),
  createAlbum: created((req) => catalog.createAlbum(me(req), b(req))),
  updateAlbum: json((req) => catalog.updateAlbum(me(req), p(req).id, b(req))),
  setTracks: json((req) => catalog.setTracks(me(req), p(req).id, b(req).songIds)),
  albumArtwork: json(async (req) => catalog.setArtwork(me(req), 'album', p(req).id, await media.storeArtwork(req))),
  deleteAlbum: json((req) => catalog.deleteAlbum(me(req), p(req).id)),

  uploads: json((req) => uploads.listUploads(q(req))),
  upload: json((req) => uploads.uploadDetail(p(req).id)),
  uploadAudio: async (req, res) => stream(res, await uploads.previewFile(p(req).id)),
  createUpload: created((req) => uploads.createIntent(me(req), req.ip, b(req), { source: 'ADMIN' })),
  scanUpload: json((req) => uploads.scanUpload(p(req).id, me(req))),
  decideUpload: json((req) => uploads.decide(me(req), p(req).id, b(req))),
  publishUpload: json((req) => uploads.publishUpload(me(req), p(req).id)),
  media: json(() => catalog.mediaLibrary()),
  checkMedia: json(() => media.checkLocal()),
  mediaAudio: async (req, res) => stream(res, await catalog.previewMedia(p(req).id)),
  registerMedia: created((req) => catalog.registerLibraryFile(me(req), p(req).id, b(req))),
  removeMedia: json((req) => catalog.removeMedia(me(req), p(req).id, p(req).mediaId)),

  reports: json((req) => reports.list(q(req))),
  report: json((req) => reports.detail(p(req).id)),
  reportNote: json((req) => reports.addNote(me(req), p(req).id, b(req).body)),
  assignReport: json((req) => reports.assign(me(req), p(req).id)),
  resolveReport: json((req) => reports.resolve(me(req), p(req).id, b(req))),

  taxonomy: json(() => platform.taxonomy()),
  updateMood: json((req) => platform.updateMood(me(req), p(req).id, b(req))),
  addKeyword: created((req) => platform.addKeyword(me(req), b(req))),
  removeKeyword: json((req) => platform.removeKeyword(me(req), p(req).id)),
  createGenre: created((req) => platform.saveGenre(me(req), null, b(req))),
  updateGenre: json((req) => platform.saveGenre(me(req), p(req).id, b(req))),
  deleteGenre: json((req) => platform.deleteGenre(me(req), p(req).id)),
  createLanguage: created((req) => platform.saveLanguage(me(req), null, b(req))),
  updateLanguage: json((req) => platform.saveLanguage(me(req), p(req).id, b(req))),
  updateContext: json((req) => platform.updateContext(me(req), p(req).id, b(req))),
  settings: json(() => settings.describe()),
  updateSettings: json((req) => settings.update(me(req), b(req).changes)),
  weights: json(() => platform.weights()),
  updateWeights: json((req) => platform.updateWeights(me(req), b(req).changes)),
  picks: json(() => platform.listPicks()),
  createPick: created((req) => platform.savePick(me(req), null, b(req))),
  updatePick: json((req) => platform.savePick(me(req), p(req).id, b(req))),
  deletePick: json((req) => platform.deletePick(me(req), p(req).id)),
  duplicates: json(() => platform.duplicates()),
};
