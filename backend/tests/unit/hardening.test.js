'use strict';
// Pure-logic tests for the security and operations hardening (no database needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { originAllowed, requestHosts, patternToRegExp } = require('../../src/utils/origins');
const { isWeakPassword } = require('../../src/utils/passwordPolicy');
const { mediaPersistence } = require('../../src/providers/runtimeCapabilities');
const { parseTrustProxy, parseOrigins } = require('../../src/config/env');
const { validate: validateSetting, DEFS } = require('../../src/services/settingsService');
const { csvCell } = require('../../src/services/auditService');
const { stateOf, TRANSITIONS } = require('../../src/services/catalogAdminService');
const { detectImage } = require('../../src/utils/audioSignature');
const { uploadToken } = require('../../src/services/uploadService');
const { scan } = require('../../../scripts/secret-scan');

test('CORS: exact origins and single-label wildcards only', () => {
  const allowed = ['https://loop.example.com', 'https://loop-final-*-gowtham.vercel.app'];
  assert.equal(originAllowed('https://loop.example.com', allowed), true);
  assert.equal(originAllowed('https://LOOP.example.com', allowed), true);
  assert.equal(originAllowed('https://loop-final-abc123-gowtham.vercel.app', allowed), true);
  // the wildcard is one DNS label: no dots, no other suffixes
  assert.equal(originAllowed('https://loop-final-a.b-gowtham.vercel.app', allowed), false);
  assert.equal(originAllowed('https://loop-final-x-gowtham.vercel.app.evil.com', allowed), false);
  assert.equal(originAllowed('https://evil.com', allowed), false);
  assert.equal(originAllowed('http://loop.example.com', allowed), false);
  assert.equal(originAllowed('null', allowed), false);
  assert.equal(originAllowed('', allowed), false);
  assert.equal(originAllowed('https://loop.example.com/path', allowed), false);
  assert.equal(originAllowed('https://user@loop.example.com', allowed), false);
  assert.equal(patternToRegExp('https://a-*.b.app').test('https://a-x.b.app'), true);
});

test('CORS_ORIGIN parsing rejects a bare * and malformed entries', () => {
  assert.deepEqual(parseOrigins('https://a.com/, https://b-*.vercel.app'), ['https://a.com', 'https://b-*.vercel.app']);
  assert.throws(() => parseOrigins('*'), /full origin/);
  assert.throws(() => parseOrigins('a.com'), /full origin/);
  assert.throws(() => parseOrigins('https://a.com/path'), /full origin/);
  assert.throws(() => parseOrigins('https://*-*.vercel.app'), /at most one/);
});

test('TRUST_PROXY accepts hop counts or proxy names, never true/false', () => {
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy('loopback, uniquelocal'), 'loopback, uniquelocal');
  assert.throws(() => parseTrustProxy('true'), /hop count/);
  assert.throws(() => parseTrustProxy('9'), /between 0 and 5/);
});

test('forwarded host is only believed behind a trusted proxy', () => {
  const req = { get: (h) => ({ host: 'loop-api.up.railway.app', 'x-forwarded-host': 'loop.example.com' })[h] };
  assert.deepEqual(requestHosts(req, 0), ['loop-api.up.railway.app']);
  assert.deepEqual(requestHosts(req, 2), ['loop-api.up.railway.app', 'loop.example.com']);
});

test('published seed passwords and common passwords are refused', () => {
  for (const pw of ['Admin@123', 'listener@123', 'Curator@123', 'varsha@27', 'Password123']) assert.equal(isWeakPassword(pw), true, pw);
  assert.equal(isWeakPassword('a-Long-unique-pass-42'), false);
});

test('media on Railway persists only inside the mounted volume', () => {
  const p = path.posix;
  assert.equal(mediaPersistence({ onRailway: false, volumePath: null, dir: '/srv/media', path: p }), 'assumed');
  assert.equal(mediaPersistence({ onRailway: true, volumePath: null, dir: '/app/media', path: p }), 'ephemeral');
  assert.equal(mediaPersistence({ onRailway: true, volumePath: '/data', dir: '/data', path: p }), 'persistent');
  assert.equal(mediaPersistence({ onRailway: true, volumePath: '/data', dir: '/data/media', path: p }), 'persistent');
  assert.equal(mediaPersistence({ onRailway: true, volumePath: '/data', dir: '/app/media', path: p }), 'ephemeral');
  assert.equal(mediaPersistence({ onRailway: true, volumePath: '/data', dir: '/data-other', path: p }), 'ephemeral');
});

test('platform settings are validated against their definitions', () => {
  assert.equal(validateSetting('registration_open', false), 'false');
  assert.equal(validateSetting('upload_max_mb', 20), '20');
  assert.throws(() => validateSetting('upload_max_mb', 51), /1 to 50/);
  assert.throws(() => validateSetting('upload_max_mb', 2.5), /whole number/);
  assert.throws(() => validateSetting('registration_open', 'yes'), /on or off/);
  assert.throws(() => validateSetting('maintenance_message', 'x'.repeat(301)), /300/);
  assert.throws(() => validateSetting('database_password', 'x'), /Unknown setting/);
  assert.ok(!Object.keys(DEFS).some((k) => /secret|password|token|key/i.test(k)), 'no secrets are editable in the console');
});

test('audit CSV cells are quoted and spreadsheet formulas neutralised', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-1+2'), `"'-1+2"`);
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
});

test('song states and allowed moderation transitions', () => {
  assert.equal(stateOf('ACTIVE', 'CLEAR'), 'PUBLISHED');
  assert.equal(stateOf('PENDING_ANALYSIS', 'CLEAR'), 'NEEDS_PROFILE');
  assert.equal(stateOf('INACTIVE', 'CLEAR'), 'HIDDEN');
  assert.equal(stateOf('ACTIVE', 'SUSPENDED'), 'SUSPENDED');
  assert.equal(stateOf('MERGED', 'TAKEN_DOWN'), 'MERGED');
  assert.ok(!TRANSITIONS.PUBLISHED.includes('RESTORE'));
  assert.deepEqual(TRANSITIONS.TAKEN_DOWN, ['RESTORE']);
  assert.deepEqual(TRANSITIONS.WITHDRAWN, [], 'an artist withdrawal cannot be reversed by an Admin');
  assert.deepEqual(TRANSITIONS.MERGED, []);
});

test('artwork is recognised from its bytes, not its name', () => {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(16)]);
  assert.equal(detectImage(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).mime, 'image/jpeg');
  assert.equal(detectImage(pad(Buffer.from('89504e470d0a1a0a', 'hex'))).mime, 'image/png');
  assert.equal(detectImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])).mime, 'image/webp');
  assert.equal(detectImage(pad(Buffer.from('<svg xmlns='))), null, 'SVG (script-capable) is refused');
  assert.equal(detectImage(pad(Buffer.from('GIF89a'))), null);
});

test('upload tokens are per-upload HMACs', () => {
  const a = uploadToken('a'.repeat(32));
  assert.equal(a.length, 43);
  assert.equal(a, uploadToken('a'.repeat(32)));
  assert.notEqual(a, uploadToken('b'.repeat(32)));
});

test('secret scan finds keys and forbidden files, ignores placeholders', () => {
  const files = {
    '.env': 'X=1',
    'media/song.mp3': '',
    'backups/loop-db-20260101T000000Z.sql.gz': '',
    // fake keys are assembled at run time so this file itself never contains one
    'docs/a.md': `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'} here`,
    'src/x.js': `const k = '${'re_'}AbCdEfGh_0123456789abcdefXYZ';`,
    'deploy.env': 'DB_APP_PASSWORD=hunter2-real-value\nSESSION_SECRET=replace-with-at-least-32-random-characters',
    '.env.example': 'SESSION_SECRET=replace-with-at-least-32-random-characters\nDB_OWNER_PASSWORD=replace-with-owner-password',
    'README.md': 'nothing secret',
    'media/README.md': 'readme',
  };
  const found = scan(Object.keys(files), (f) => Buffer.from(files[f]));
  const byFile = (f) => found.filter((x) => x.file === f).length;
  assert.equal(byFile('.env'), 1);
  assert.equal(byFile('media/song.mp3'), 1);
  assert.equal(byFile('backups/loop-db-20260101T000000Z.sql.gz'), 1);
  assert.equal(byFile('docs/a.md'), 1);
  assert.equal(byFile('src/x.js'), 1);
  assert.equal(byFile('deploy.env'), 1, 'only the real-looking value is flagged');
  assert.equal(byFile('.env.example'), 0);
  assert.equal(byFile('README.md'), 0);
  assert.equal(byFile('media/README.md'), 0);
});
