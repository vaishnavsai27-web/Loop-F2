// Production logging: one JSON object per line on stdout/stderr (Railway collects both).
// Never pass passwords, tokens, cookies, emails or request bodies to these functions.
const { nodeEnv } = require('../config/env');

function write(level, msg, fields) {
  if (nodeEnv === 'test' && level === 'info') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}

module.exports = {
  info: (msg, fields = {}) => write('info', msg, fields),
  warn: (msg, fields = {}) => write('warn', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};
