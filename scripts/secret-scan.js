#!/usr/bin/env node
'use strict';
// Scans every file git would commit for credentials and for files that must never be committed
// (environment files, private keys, database dumps, private audio). Run before pushing:
//   npm run secret:scan            (tracked and staged files)
// Exit code 1 when anything is found. No network access needed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const FORBIDDEN_FILES = [
  [/(^|\/)\.env(\.(?!example$)[^/]+)?$/, 'environment file'],
  [/\.(pem|key|p12|pfx)$/i, 'private key or certificate bundle'],
  [/\.(sql\.gz|sql\.gz\.sha256|dump)$/i, 'database dump'],
  [/(^|\/)backups\//, 'backup folder'],
  [/^media\/(?!README\.md$)/, 'private media file'],
  [/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i, 'audio file'],
];

const PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/, 'Resend API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/, 'Stripe live key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bmysql:\/\/[^:\s/]+:(?!\$\{|<|password|change-me|replace-)[^@\s]{6,}@(?!localhost|127\.0\.0\.1)/i, 'MySQL URL with a password'],
  [/railway\.app\/[^\s"']*\?token=/i, 'Railway token in a URL'],
  [/\bvercel_[A-Za-z0-9]{24,}\b/, 'Vercel token'],
];

// Assignments in env-style files: KEY=value where the key names a secret and the value is real.
const SECRET_KEY = /^(?:export\s+)?([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*(.*)$/;
const PLACEHOLDER = /^(|["']?(replace-|change-me|changeme|your-|example|<|\$\{|ci-only-|ci-root-|drill-only-|test-|dev-only-|local-only-)[^]*)$/i;

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function scan(files = listFiles(), read = (f) => fs.readFileSync(path.join(root, f))) {
  const findings = [];
  for (const file of files) {
    if (file === 'scripts/secret-scan.js') continue;
    const forbidden = FORBIDDEN_FILES.find(([re]) => re.test(file));
    if (forbidden) { findings.push({ file, line: 0, what: forbidden[1] }); continue; }
    let buf;
    try { buf = read(file); } catch { continue; }
    if (buf.length > 5 * 1024 * 1024 || buf.includes(0)) continue; // binary or huge: not text
    const lines = buf.toString('utf8').split(/\r?\n/);
    const envLike = /(^|\/)\.env\.example$|\.(env|ini|cfg|conf|properties|toml)$/i.test(file);
    lines.forEach((text, i) => {
      for (const [re, what] of PATTERNS) if (re.test(text)) findings.push({ file, line: i + 1, what });
      if (envLike) {
        const m = text.match(SECRET_KEY);
        if (m && !PLACEHOLDER.test(m[2].trim())) findings.push({ file, line: i + 1, what: `${m[1]} has a real-looking value` });
      }
    });
  }
  return findings;
}

if (require.main === module) {
  const findings = scan();
  for (const f of findings) console.error(`FOUND  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.what}`);
  console.log(findings.length ? `\n${findings.length} possible secret(s) or forbidden file(s). Remove them before committing.` : 'Secret scan: nothing found.');
  process.exitCode = findings.length ? 1 : 0;
}

module.exports = { scan };
