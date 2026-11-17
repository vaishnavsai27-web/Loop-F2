'use strict';

/**
 * Decide whether local-filesystem audio is safe to use in this process.
 * Serverless function filesystems are ephemeral, so an explicit enable flag
 * must never override the serverless safety boundary.
 */
function localMediaEnabled({ isServerless, configured }) {
  if (isServerless) return false;
  if (configured === undefined || configured === null || configured === '') return true;
  return String(configured).toLowerCase() === 'true';
}

/**
 * Is the media directory on storage that survives a redeploy?
 *  - Railway: only inside an attached volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH).
 *  - Other persistent hosts (a VPS, local development): the directory is assumed to persist.
 */
function mediaPersistence({ onRailway, volumePath, dir, path = require('path') }) {
  if (!onRailway) return 'assumed';
  if (!volumePath) return 'ephemeral';
  const rel = path.relative(path.resolve(volumePath), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? 'persistent' : 'ephemeral';
}

module.exports = { localMediaEnabled, mediaPersistence };
