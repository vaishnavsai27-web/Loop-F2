// Configuration for LOOP-owned media. No external music-service credentials are read.
const path = require('path');
const runtime = require('../config/env');
const { localMediaEnabled } = require('./runtimeCapabilities');

const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
// Default location: inside the Railway volume when one is attached, else <repo>/media.
const defaultDir = volumePath ? path.join(volumePath, 'media') : path.resolve(__dirname, '../../../media');

module.exports = {
  localMedia: {
    enabled: localMediaEnabled({ isServerless: runtime.isServerless, configured: process.env.LOCAL_MEDIA_ENABLED }),
    dir: path.resolve(process.env.LOCAL_MEDIA_DIR || defaultDir),
    volumePath,
    onRailway: runtime.onRailway,
    // Development escape hatch only: accept uploads on a Railway container without a volume.
    allowEphemeral: process.env.ALLOW_EPHEMERAL_MEDIA === 'true',
  },
};
