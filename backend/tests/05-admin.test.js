// Admin console operations against the real database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let admin;
before(async () => { await h.start(); admin = await h.adminLogin(); });
after(h.stop);

test('overview reports the queues an Admin acts on', async () => {
  const r = await h.api('GET', '/admin/overview', { token: admin });
  assert.equal(r.status, 200);
  for (const k of ['songs_published', 'songs_playable', 'users_total', 'applications_pending', 'uploads_to_review', 'reports_open', 'mood_requests_7d']) {
    assert.ok(k in r.body.counts, k);
  }
  assert.ok(Array.isArray(r.body.recentAdminActivity));
  const badges = await h.api('GET', '/admin/badges', { token: admin });
  assert.equal(badges.status, 200);
});

test('a song added with audio features is analysed, tagged with moods and recommendable', async () => {
  const refs = await h.api('GET', '/admin/references', { token: admin });
  const artist = refs.body.artists[0];
  const genre = refs.body.genres[0];
  const title = `Test Calm ${h.uid()}`;
  const r = await h.api('POST', '/admin/songs', { token: admin, body: {
    title, artistId: artist.id, genreId: genre.id, durationSec: 210, releaseYear: 2026,
    features: { energy: 0.22, valence: 0.55, danceability: 0.3, acousticness: 0.75, instrumentalness: 0.5, speechiness: 0.04, tempo_bpm: 80 },
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ACTIVE');
  assert.ok(r.body.moodsDetailed.length > 0, 'the active mood model tagged it');
  assert.ok(await h.one('SELECT 1 AS ok FROM v_recommendation_candidates WHERE song_id = ?', [r.body.id]));
  const noFeatures = await h.api('POST', '/admin/songs', { token: admin, body: { title: `${title} B`, artistId: artist.id, genreId: genre.id, durationSec: 200, releaseYear: 2026 } });
  assert.equal(noFeatures.body.state, 'NEEDS_PROFILE', 'without features a song waits and is never recommended');
  assert.equal(await h.one('SELECT 1 AS ok FROM v_recommendation_candidates WHERE song_id = ?', [noFeatures.body.id]), null);
});

test('hiding a song removes it from search and recommendations; unhiding brings it back', async () => {
  const s = await h.activeSong();
  const u = await h.newUser();
  const hide = await h.api('POST', `/admin/songs/${s.song_id}/state`, { token: admin, body: { action: 'HIDE', reason: 'Test' } });
  assert.equal(hide.status, 200, JSON.stringify(hide.body));
  try {
    assert.equal((await h.api('GET', `/songs/${s.song_id}`, { token: u.token })).status, 404);
    assert.equal(await h.one('SELECT 1 AS ok FROM v_recommendation_candidates WHERE song_id = ?', [s.song_id]), null);
    const bad = await h.api('POST', `/admin/songs/${s.song_id}/state`, { token: admin, body: { action: 'RESTORE' } });
    assert.equal(bad.status, 409, 'only actions allowed from the current state');
  } finally {
    await h.api('POST', `/admin/songs/${s.song_id}/state`, { token: admin, body: { action: 'UNHIDE' } });
  }
  assert.equal((await h.api('GET', `/songs/${s.song_id}`, { token: u.token })).status, 200);
});

test('a suspended song cannot be published by any route until it is restored', async () => {
  const s = await h.activeSong();
  assert.equal((await h.api('POST', `/admin/songs/${s.song_id}/state`, { token: admin, body: { action: 'SUSPEND', reason: 'Report under review' } })).status, 200);
  try {
    await assert.rejects(h.query("UPDATE songs SET status = 'ACTIVE' WHERE song_id = ?", [s.song_id]), 'the database trigger blocks publication');
    const detail = await h.api('GET', `/admin/songs/${s.song_id}`, { token: admin });
    assert.equal(detail.body.state, 'SUSPENDED');
    assert.deepEqual(detail.body.allowedActions, ['RESTORE', 'TAKE_DOWN']);
  } finally {
    assert.equal((await h.api('POST', `/admin/songs/${s.song_id}/state`, { token: admin, body: { action: 'RESTORE' } })).status, 200);
  }
});

test('mood curation is stored, audited and re-applied by the mood model', async () => {
  const s = await h.activeSong();
  const mood = await h.one("SELECT mood_id FROM moods WHERE name = 'Romantic'");
  const r = await h.api('PUT', `/admin/songs/${s.song_id}/moods/${mood.mood_id}`, { token: admin, body: { action: 'ADD', confidence: 0.9 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.curations.some((c) => c.id === mood.mood_id));
  assert.ok(await h.one("SELECT 1 AS ok FROM audit_logs WHERE action = 'MOOD_CURATED' AND entity_id = ?", [String(s.song_id)]));
  assert.equal((await h.api('DELETE', `/admin/songs/${s.song_id}/moods/${mood.mood_id}`, { token: admin })).status, 200);
});

test('registering LOOP audio needs a real file in the media folder', async () => {
  const s = await h.metadataOnlySong();
  const bad = await h.api('POST', `/admin/songs/${s.song_id}/media`, { token: admin, body: { fileName: 'not-there.mp3' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'LOCAL_FILE_NOT_FOUND');
  const traversal = await h.api('POST', `/admin/songs/${s.song_id}/media`, { token: admin, body: { fileName: '../etc/passwd' } });
  assert.equal(traversal.status, 400);
  await h.makePlayable(s.song_id);
  const media = await h.api('GET', '/admin/media', { token: admin });
  assert.equal(media.body.storage.state, 'ready');
});

test('deactivating a user signs them out everywhere and reactivation restores access', async () => {
  const u = await h.newUser({ onboard: false });
  assert.equal((await h.api('POST', `/admin/users/${u.id}/active`, { token: admin, body: { active: false } })).status, 400, 'a reason is required');
  assert.equal((await h.api('POST', `/admin/users/${u.id}/active`, { token: admin, body: { active: false, reason: 'Test deactivation' } })).status, 200);
  assert.equal((await h.api('GET', '/auth/me', { token: u.token })).status, 401);
  assert.equal((await h.api('POST', `/admin/users/${u.id}/active`, { token: admin, body: { active: true } })).status, 200);
  assert.equal((await h.api('POST', '/auth/login', { body: { login: u.username, password: 'Testpass1' } })).status, 200);
});

test('system health reports integrity checks without secrets', async () => {
  const r = await h.api('GET', '/admin/health', { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.integrity.length > 0);
  assert.ok(r.body.mediaStorage.state);
  const text = JSON.stringify(r.body);
  for (const k of ['DB_APP_PASSWORD', 'SESSION_SECRET', 'DB_OWNER_PASSWORD']) if (process.env[k]) assert.ok(!text.includes(process.env[k]), `${k} leaked`);
});

test('platform settings change without SQL, are validated and audited', async () => {
  const before = await h.api('GET', '/admin/settings', { token: admin });
  assert.equal(before.status, 200);
  const bad = await h.api('PUT', '/admin/settings', { token: admin, body: { changes: { upload_max_mb: 500 } } });
  assert.equal(bad.status, 400);
  const ok = await h.api('PUT', '/admin/settings', { token: admin, body: { changes: { maintenance_message: 'Test notice' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await h.api('GET', '/platform')).body.maintenanceMessage, 'Test notice');
  await h.api('PUT', '/admin/settings', { token: admin, body: { changes: { maintenance_message: '' } } });
  assert.ok(await h.one("SELECT 1 AS ok FROM audit_logs WHERE action = 'SETTINGS_CHANGED' LIMIT 1"));
});

test('a listener report reaches the Admin queue and its resolution is sent back', async () => {
  const u = await h.newUser({ onboard: false });
  const s = await h.activeSong();
  const rep = await h.api('POST', '/reports', { token: u.token, body: { targetType: 'SONG', targetId: s.song_id, reason: 'MISLABELLED', details: 'The genre is wrong on this one.' } });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  const list = await h.api('GET', '/admin/reports?status=OPEN', { token: admin });
  assert.ok(list.body.reports.some((r) => r.id === rep.body.id));
  assert.equal((await h.api('POST', `/admin/reports/${rep.body.id}/notes`, { token: admin, body: { body: 'Checked the metadata.' } })).status, 200);
  const done = await h.api('POST', `/admin/reports/${rep.body.id}/resolve`, { token: admin, body: { outcome: 'DISMISSED', action: 'NONE', note: 'The genre is correct.' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const mine = await h.api('GET', '/me/reports', { token: u.token });
  assert.equal(mine.body.find((r) => r.id === rep.body.id).status, 'DISMISSED');
  const inbox = await h.api('GET', '/me/notifications', { token: u.token });
  assert.ok(inbox.body.items.length > 0, 'the reporter is notified');
});

test('the audit log is filterable and exports CSV', async () => {
  const r = await h.api('GET', '/admin/audit?action=SETTINGS_CHANGED', { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.entries.every((e) => e.action === 'SETTINGS_CHANGED'));
  const csv = await fetch(`${(await h.start())}/admin/audit.csv?action=SETTINGS_CHANGED`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /^id,time,actor,action/);
});
