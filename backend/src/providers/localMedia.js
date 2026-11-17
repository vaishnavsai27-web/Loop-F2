// LOOP-owned audio and artwork on a persistent filesystem (a Railway volume in production).
//   <dir>/                  playable audio registered in song_media (library files and published uploads)
//   <dir>/artist-quarantine private uploads waiting for scan and review (never served publicly)
//   <dir>/retained          withdrawn or taken-down recordings kept for rights disputes (never served, never registrable)
//   <dir>/artwork           album and song artwork (served publicly)
// A registered file that is missing on disk is reported as unavailable, never played.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { mediaPersistence } = require('./runtimeCapabilities');

const CODE = 'LOCAL_MEDIA';
const EXT = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
// Files produced by the upload pipeline are managed by it, not registered by hand.
const MANAGED = /^(artist|loop)_[a-f0-9]{32}\./;

const dir = () => cfg.localMedia.dir;
const sub = (name) => path.join(dir(), name);
const persistence = () => mediaPersistence({ onRailway: cfg.localMedia.onRailway, volumePath: cfg.localMedia.volumePath, dir: dir() });

/**
 * disabled  — no media on this host (serverless or LOCAL_MEDIA_ENABLED=false)
 * ephemeral — files would be lost on redeploy (Railway without a volume): playback of existing files only, no writes
 * ready     — persistent storage; uploads, registration and publication allowed
 */
function check() {
  if (!cfg.localMedia.enabled) return { state: 'disabled', writable: false, persistence: 'none' };
  const p = persistence();
  if (p === 'ephemeral' && !cfg.localMedia.allowEphemeral) {
    return { state: 'ephemeral', writable: false, persistence: p,
      detail: 'No Railway volume is attached at the media folder, so uploads would be lost on the next deploy. Attach a volume to enable uploads.' };
  }
  const exists = fs.existsSync(dir());
  return { state: 'ready', writable: true, persistence: p,
    detail: exists ? `${list().length} library audio file(s); storage ${p === 'persistent' ? 'on a persistent volume' : 'on this server'}` : 'media folder will be created on first upload' };
}

const writable = () => check().writable;

/** Validate a file name and return its absolute path, or null if unsafe/unsupported. */
function resolveFile(name, folder = '') {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) return null;
  const ext = path.extname(name).toLowerCase();
  if (!EXT[ext]) return null;
  const base = folder ? sub(folder) : dir();
  const full = path.join(base, name);
  if (path.dirname(full) !== base) return null;
  return { full, type: EXT[ext] };
}

function resolveArtwork(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) return null;
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT[ext]) return null;
  const full = path.join(sub('artwork'), name);
  if (path.dirname(full) !== sub('artwork')) return null;
  return { full, type: IMAGE_EXT[ext] };
}

function available(name) {
  if (!cfg.localMedia.enabled) return false;
  const f = resolveFile(name);
  return !!(f && fs.existsSync(f.full) && fs.statSync(f.full).isFile());
}

/** Library files an Admin may register by hand (pipeline-managed files are excluded). */
function list() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((n) => !MANAGED.test(n) && resolveFile(n) && fs.statSync(path.join(dir(), n)).isFile()).sort();
}

/** Move a published file out of the playable folder (withdrawal, takedown, audio removal). */
async function retain(name) {
  const f = resolveFile(name);
  if (!f || !fs.existsSync(f.full)) return false;
  await fs.promises.mkdir(sub('retained'), { recursive: true, mode: 0o700 });
  await fs.promises.rename(f.full, path.join(sub('retained'), `${Date.now()}_${name}`));
  return true;
}

module.exports = { code: CODE, check, writable, resolveFile, resolveArtwork, available, list, retain, dir, sub, EXT, IMAGE_EXT, MANAGED };
