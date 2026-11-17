// Thin fetch wrapper. Every call goes to LOOP's Express API (/api/...), which
// reads and writes LOOP's MySQL database. Nothing is faked in the browser.
//
// Authentication: the session lives in an httpOnly cookie that page scripts
// cannot read. State-changing requests also send the CSRF token from the
// readable `muse_csrf` cookie (double-submit, verified server-side).

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(name, source) {
  const all = source !== undefined ? source : (typeof document !== 'undefined' ? document.cookie : '');
  for (const part of String(all || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function buildHeaders(method, hasBody, cookieSource) {
  const headers = { Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (!SAFE.has(method)) {
    const csrf = readCookie('muse_csrf', cookieSource);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

export const qs = (o = {}) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p).toString()}` : '';
};

let onUnauthorized = () => {};
let onPasswordChange = () => {};
let onReauth = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export const setPasswordChangeHandler = (fn) => { onPasswordChange = fn; };
/** fn() resolves true once the person re-entered their password, false if they cancelled. */
export const setReauthHandler = (fn) => { onReauth = fn; };
const QUIET_401 = new Set(['/auth/session', '/auth/login', '/auth/register', '/auth/reauth']);

export async function request(method, path, body, { timeoutMs = 15000, raw = null, headers: extra = {}, retried = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    const hasBody = body !== undefined && raw === null;
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...buildHeaders(method, hasBody), ...extra },
      body: raw !== null ? raw : hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'LOOP took too long to answer. Try again in a moment.');
    throw new ApiError(0, 'NETWORK', 'LOOP’s server can’t be reached. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const fallback = res.status >= 500 ? 'LOOP’s server had a problem. Try again in a moment.' : 'That request could not be completed.';
    const e = data && data.error ? data.error : { code: `HTTP_${res.status}`, message: fallback };
    // Step-up authentication: ask for the password once, then repeat the same request.
    if (e.code === 'REAUTH_REQUIRED' && onReauth && !retried) {
      if (await onReauth()) return request(method, path, body, { timeoutMs, raw, headers: extra, retried: true });
      throw new ApiError(res.status, 'REAUTH_CANCELLED', 'Action cancelled: your password was not confirmed.');
    }
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChange();
    if (res.status === 401 && e.code !== 'REAUTH_REQUIRED' && !QUIET_401.has(path)) onUnauthorized(e);
    throw new ApiError(res.status, e.code, e.message || fallback, e.details);
  }
  return data;
}

/**
 * Send a file with upload progress (fetch has none). `url` may be the API host itself (direct upload,
 * authorised by the upload token) or the same-origin /api path.
 */
export function uploadFile(url, file, { token, onProgress, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const sameOrigin = url.startsWith('/');
    xhr.open('PUT', url);
    xhr.timeout = timeoutMs;
    xhr.withCredentials = sameOrigin;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('X-Upload-Token', token);
    if (sameOrigin) { const csrf = readCookie('muse_csrf'); if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf); }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText || 'null'); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || `HTTP_${xhr.status}`, data?.error?.message || 'The upload did not finish. Try again.'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'The connection dropped during the upload. Try again.'));
    xhr.ontimeout = () => reject(new ApiError(0, 'TIMEOUT', 'The upload took too long. Try again on a faster connection.'));
    xhr.send(file);
  });
}

const get = (p, q) => request('GET', p + qs(q));
const post = (p, b = {}) => request('POST', p, b);
const put = (p, b = {}) => request('PUT', p, b);
const patch = (p, b = {}) => request('PATCH', p, b);
const del = (p, b) => request('DELETE', p, b);
const putRaw = (p, file) => request('PUT', p, undefined, { raw: file, timeoutMs: 60000, headers: { 'Content-Type': file.type || 'application/octet-stream' } });

export const api = {
  // auth & recovery
  session: () => get('/auth/session'),
  platform: () => get('/platform'),
  login: (login, password) => post('/auth/login', { login, password }),
  register: (body) => post('/auth/register', body),
  logout: () => post('/auth/logout'),
  logoutAll: () => post('/auth/logout-all'),
  reauth: (password) => post('/auth/reauth', { password }),
  requestReset: (login) => post('/auth/password-reset/request', { login }),
  confirmReset: (token, newPassword) => post('/auth/password-reset/confirm', { token, newPassword }),
  verifyEmail: (token) => post('/auth/verify-email', { token }),

  // reference data
  moods: () => get('/moods'),
  contexts: () => get('/contexts'),
  languages: () => get('/languages'),
  genres: () => get('/genres'),
  picks: () => get('/picks'),

  // discovery
  recommend: (body) => post('/recommendations/mood', body),
  parseMood: (text) => get('/recommendations/parse', { text }),
  forYou: (limit = 12) => get('/recommendations/for-you', { limit }),
  similar: (seed, limit = 12) => get('/recommendations/similar', { seed, limit }),
  batch: (id) => get(`/recommendations/batches/${id}`),
  moodHistory: (limit = 12) => get('/recommendations/history', { limit }),

  // catalogue
  search: (q) => get('/search', { q }),
  browse: (q) => get('/songs', q),
  song: (id) => get(`/songs/${id}`),
  artist: (id) => get(`/artists/${id}`),
  album: (id) => get(`/albums/${id}`),
  sharedPlaylist: (token) => get(`/shared/playlists/${token}`),

  // feedback & reports
  like: (id, liked) => put(`/songs/${id}/like`, { liked }),
  rate: (id, rating) => put(`/songs/${id}/rating`, { rating }),
  unrate: (id) => del(`/songs/${id}/rating`),
  dismiss: (id, batchId) => put(`/songs/${id}/dismiss`, batchId ? { batchId } : {}),
  undismiss: (id) => del(`/songs/${id}/dismiss`),
  likes: () => get('/likes'),
  dismissals: () => get('/me/dismissals'),
  report: (body) => post('/reports', body),
  myReports: () => get('/me/reports'),

  // library
  playlists: () => get('/playlists'),
  playlist: (id) => get(`/playlists/${id}`),
  createPlaylist: (body) => post('/playlists', body),
  saveMix: (batchId, name) => post('/playlists/from-batch', { batchId, name }),
  renamePlaylist: (id, body) => patch(`/playlists/${id}`, body),
  deletePlaylist: (id) => del(`/playlists/${id}`),
  addToPlaylist: (id, songId) => post(`/playlists/${id}/songs`, { songId }),
  removeFromPlaylist: (id, songId) => del(`/playlists/${id}/songs/${songId}`),
  reorderPlaylist: (id, songIds) => put(`/playlists/${id}/order`, { songIds }),
  sharePlaylist: (id, enabled) => put(`/playlists/${id}/share`, { enabled }),

  // playback
  startPlay: (songId, origin, batchId) => post('/playback/start', { songId, origin, ...(batchId ? { batchId } : {}) }),
  finishPlay: (playId, listenedSec, positionSec) => post(`/playback/${playId}/finish`, { listenedSec, ...(positionSec !== undefined ? { positionSec } : {}) }),
  history: (limit = 20) => get('/history', { limit }),

  // account
  me: () => get('/auth/me'),
  preferences: () => get('/me/preferences'),
  savePreferences: (body) => put('/me/preferences', body),
  updateSettings: (body) => patch('/me/settings', body),
  sessions: () => get('/me/sessions'),
  revokeSession: (id) => del(`/me/sessions/${id}`),
  changePassword: (currentPassword, newPassword) => post('/me/password', { currentPassword, newPassword }),
  sendVerification: () => post('/me/verify-email'),
  deleteAccount: (password) => del('/me', { password, confirm: 'DELETE' }),
  notifications: () => get('/me/notifications'),
  readNotifications: (ids) => post('/me/notifications/read', ids ? { ids } : {}),
  privacy: () => get('/me/privacy'),
  clearSearchHistory: () => del('/me/history/search'),
  clearListeningHistory: () => del('/me/history/listening'),

  // artist
  artistMe: () => get('/artist/me'),
  artistStats: () => get('/artist/stats'),
  applyArtist: (body) => post('/artist/applications', body),
  withdrawApplication: (id) => post(`/artist/applications/${id}/withdraw`),
  updateArtistProfile: (id, body) => patch(`/artist/profiles/${id}`, body),
  createUpload: (body) => post('/artist/uploads', body),
  artistUpload: (id) => get(`/artist/uploads/${id}`),
  uploadArtwork: (id, file) => putRaw(`/artist/uploads/${id}/artwork`, file),
  withdrawUpload: (id, reason) => post(`/artist/uploads/${id}/withdraw`, reason ? { reason } : {}),

  // admin
  admin: {
    overview: () => get('/admin/overview'),
    badges: () => get('/admin/badges'),
    health: () => get('/admin/health'),
    permissions: () => get('/admin/permissions'),
    references: () => get('/admin/references'),
    audit: (q) => get('/admin/audit', q),
    auditCsvUrl: (q) => `/api/admin/audit.csv${qs(q)}`,

    users: (q) => get('/admin/users', q),
    user: (id) => get(`/admin/users/${id}`),
    setActive: (id, active, reason) => post(`/admin/users/${id}/active`, { active, ...(reason ? { reason } : {}) }),
    setLock: (id, locked, reason) => post(`/admin/users/${id}/lock`, { locked, ...(reason ? { reason } : {}) }),
    setRole: (id, role) => post(`/admin/users/${id}/role`, { role }),
    resetLink: (id) => post(`/admin/users/${id}/reset-link`),
    signOutUser: (id) => post(`/admin/users/${id}/sign-out`),
    anonymise: (id, reason) => post(`/admin/users/${id}/anonymise`, { reason, confirm: 'ANONYMISE' }),
    publishedPasswords: () => get('/admin/security/published-passwords'),

    artists: (q) => get('/admin/artists', q),
    artist: (id) => get(`/admin/artists/${id}`),
    createArtist: (body) => post('/admin/artists', body),
    updateArtist: (id, body) => patch(`/admin/artists/${id}`, body),
    setAliases: (id, aliases) => put(`/admin/artists/${id}/aliases`, { aliases }),
    suspendArtist: (id, reason, hideSongs) => post(`/admin/artists/${id}/suspend`, { reason, hideSongs }),
    reinstateArtist: (id, note) => post(`/admin/artists/${id}/reinstate`, note ? { note } : {}),
    applications: (q) => get('/admin/artist-applications', q),
    decideApplication: (id, body) => post(`/admin/artist-applications/${id}/decision`, body),
    nameChanges: (q) => get('/admin/name-changes', q),
    decideNameChange: (id, action, note) => post(`/admin/name-changes/${id}/decision`, { action, ...(note ? { note } : {}) }),

    songs: (q) => get('/admin/songs', q),
    song: (id) => get(`/admin/songs/${id}`),
    createSong: (body) => post('/admin/songs', body),
    updateSong: (id, body) => patch(`/admin/songs/${id}`, body),
    songState: (id, action, reason) => post(`/admin/songs/${id}/state`, { action, ...(reason ? { reason } : {}) }),
    deleteSong: (id) => del(`/admin/songs/${id}`),
    mergeSong: (id, intoSongId) => post(`/admin/songs/${id}/merge`, { intoSongId }),
    curateMood: (id, moodId, body) => put(`/admin/songs/${id}/moods/${moodId}`, body),
    clearCuration: (id, moodId) => del(`/admin/songs/${id}/moods/${moodId}`),
    songArtwork: (id, file) => putRaw(`/admin/songs/${id}/artwork`, file),

    albums: (q) => get('/admin/albums', q),
    album: (id) => get(`/admin/albums/${id}`),
    createAlbum: (body) => post('/admin/albums', body),
    updateAlbum: (id, body) => patch(`/admin/albums/${id}`, body),
    setTracks: (id, songIds) => put(`/admin/albums/${id}/tracks`, { songIds }),
    albumArtwork: (id, file) => putRaw(`/admin/albums/${id}/artwork`, file),
    deleteAlbum: (id) => del(`/admin/albums/${id}`),

    uploads: (q) => get('/admin/uploads', q),
    upload: (id) => get(`/admin/uploads/${id}`),
    uploadAudioUrl: (id) => `/api/admin/uploads/${id}/audio`,
    createUpload: (body) => post('/admin/uploads', body),
    scanUpload: (id) => post(`/admin/uploads/${id}/scan`),
    decideUpload: (id, body) => post(`/admin/uploads/${id}/decision`, body),
    publishUpload: (id) => post(`/admin/uploads/${id}/publish`),
    media: () => get('/admin/media'),
    checkMedia: () => post('/admin/media/check'),
    mediaAudioUrl: (id) => `/api/admin/media/${id}/audio`,
    registerMedia: (songId, body) => post(`/admin/songs/${songId}/media`, body),
    removeMedia: (songId, mediaId) => del(`/admin/songs/${songId}/media/${mediaId}`),

    reports: (q) => get('/admin/reports', q),
    report: (id) => get(`/admin/reports/${id}`),
    reportNote: (id, body) => post(`/admin/reports/${id}/notes`, { body }),
    assignReport: (id) => post(`/admin/reports/${id}/assign`),
    resolveReport: (id, body) => post(`/admin/reports/${id}/resolve`, body),

    taxonomy: () => get('/admin/taxonomy'),
    updateMood: (id, body) => patch(`/admin/moods/${id}`, body),
    addPhrase: (body) => post('/admin/mood-phrases', body),
    removePhrase: (id) => del(`/admin/mood-phrases/${id}`),
    createGenre: (body) => post('/admin/genres', body),
    updateGenre: (id, body) => patch(`/admin/genres/${id}`, body),
    deleteGenre: (id) => del(`/admin/genres/${id}`),
    createLanguage: (body) => post('/admin/languages', body),
    updateLanguage: (id, body) => patch(`/admin/languages/${id}`, body),
    updateContext: (id, body) => patch(`/admin/contexts/${id}`, body),
    settings: () => get('/admin/settings'),
    updateSettings: (changes) => put('/admin/settings', { changes }),
    weights: () => get('/admin/recommender'),
    updateWeights: (changes) => put('/admin/recommender', { changes }),
    picks: () => get('/admin/picks'),
    createPick: (body) => post('/admin/picks', body),
    updatePick: (id, body) => patch(`/admin/picks/${id}`, body),
    deletePick: (id) => del(`/admin/picks/${id}`),
    duplicates: () => get('/admin/duplicates'),
  },
};
