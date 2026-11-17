const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

test('registration creates a hashed-password account and returns a token', async () => {
  const u = `t_${h.uid()}`;
  const r = await h.api('POST', '/auth/register', { body: { username: u, email: `${u}@test.dev`, password: 'Secret123', displayName: 'Reg Test', acceptTerms: true } });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.user.role, 'LISTENER');
  assert.equal(r.body.user.onboarded, false);
  const row = await h.one('SELECT password_hash FROM users WHERE username = ?', [u]);
  assert.match(row.password_hash, /^\$2[aby]\$10\$/, 'stored as bcrypt');
  assert.notEqual(row.password_hash, 'Secret123');
  const terms = await h.one('SELECT terms_version, terms_accepted_at FROM users WHERE username = ?', [u]);
  assert.ok(terms.terms_version && terms.terms_accepted_at, 'acceptance of the terms is recorded');
});

test('registration requires accepting the terms and refuses published or common passwords', async () => {
  const u = `t_${h.uid()}`;
  const body = { username: u, email: `${u}@test.dev`, password: 'Secret123', displayName: 'Terms' };
  const noTerms = await h.api('POST', '/auth/register', { body: { ...body, acceptTerms: false } });
  assert.equal(noTerms.status, 400);
  const seeded = await h.api('POST', '/auth/register', { body: { ...body, password: 'Admin@123', acceptTerms: true } });
  assert.equal(seeded.status, 400, 'a password published in the repository cannot be chosen');
});

test('registration rejects duplicates and invalid input with field details', async () => {
  const { username } = await h.newUser({ onboard: false });
  const dup = await h.api('POST', '/auth/register', { body: { username, email: `${h.uid()}@x.dev`, password: 'Secret123', displayName: 'X', acceptTerms: true } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'USERNAME_TAKEN');
  const bad = await h.api('POST', '/auth/register', { body: { username: 'Bad Name', email: 'nope', password: 'short', displayName: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  for (const f of ['username', 'email', 'password', 'displayName']) assert.ok(bad.body.error.details[f], `${f} reported`);
});

test('registration always creates a User: a role in the request is ignored', async () => {
  const u = `t_${h.uid()}`;
  const r = await h.api('POST', '/auth/register', { body: { username: u, email: `${u}@test.dev`, password: 'Secret123', displayName: 'Sneaky', role: 'ADMIN', acceptTerms: true } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'LISTENER');
  const row = await h.one('SELECT r.code FROM users u JOIN roles r USING (role_id) WHERE u.username = ?', [u]);
  assert.equal(row.code, 'LISTENER');
});

test('login works with username or email; wrong password is a generic 401', async () => {
  const ok = await h.api('POST', '/auth/login', { body: { login: 'varsha', password: 'Varsha@27' } });
  assert.equal(ok.status, 200);
  const byEmail = await h.api('POST', '/auth/login', { body: { login: 'varsha@muse.dev', password: 'Varsha@27' } });
  assert.equal(byEmail.status, 200);
  const wrong = await h.api('POST', '/auth/login', { body: { login: 'varsha', password: 'nope-nope1' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_LOGIN');
  const unknown = await h.api('POST', '/auth/login', { body: { login: 'nobody_here', password: 'nope-nope1' } });
  assert.equal(unknown.body.error.message, wrong.body.error.message, 'same message: no account enumeration');
});

test('five wrong passwords lock the account without revealing it to a guesser', async () => {
  const u = await h.newUser({ onboard: false });
  let last;
  for (let i = 0; i < 6; i++) last = await h.api('POST', '/auth/login', { body: { login: u.username, password: 'Wrong1234' } });
  assert.equal(last.status, 401, 'a wrong password always gets the same generic answer');
  assert.equal(last.body.error.code, 'INVALID_LOGIN');
  const row = await h.one('SELECT locked_until > NOW() AS locked FROM users WHERE user_id = ?', [u.id]);
  assert.equal(Number(row.locked), 1);
  const right = await h.api('POST', '/auth/login', { body: { login: u.username, password: 'Testpass1' } });
  assert.equal(right.status, 429, 'only the right password learns that the account is locked');
  assert.equal(right.body.error.code, 'ACCOUNT_LOCKED');
  assert.ok(await h.one("SELECT 1 AS ok FROM audit_logs WHERE action = 'LOGIN_FAILED' AND entity_id = ?", [String(u.id)]), 'failed sign-ins are audited');
});

test('password reset: generic answer, single-use token, other sessions revoked', async () => {
  const u = await h.newUser({ onboard: false });
  const unknown = await h.api('POST', '/auth/password-reset/request', { body: { login: 'nobody_at_all' } });
  const known = await h.api('POST', '/auth/password-reset/request', { body: { login: u.username } });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body, 'no account enumeration');
  const admin = await h.adminLogin();
  const link = await h.api('POST', `/admin/users/${u.id}/reset-link`, { token: admin });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const token = new URL(link.body.path, 'http://loop.test').searchParams.get('token');
  const done = await h.api('POST', '/auth/password-reset/confirm', { body: { token, newPassword: 'Brand-new-pass-7' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await h.api('GET', '/auth/me', { token: u.token })).status, 401, 'old sessions are signed out');
  assert.equal((await h.api('POST', '/auth/password-reset/confirm', { body: { token, newPassword: 'Another-pass-8' } })).status, 400, 'tokens work once');
  assert.equal((await h.api('POST', '/auth/login', { body: { login: u.username, password: 'Brand-new-pass-7' } })).status, 200);
});

test('deleting an account removes it, with the password and a typed confirmation', async () => {
  const u = await h.newUser();
  assert.equal((await h.api('DELETE', '/me', { token: u.token, body: { password: 'wrong-pass-1', confirm: 'DELETE' } })).status, 400);
  const r = await h.api('DELETE', '/me', { token: u.token, body: { password: 'Testpass1', confirm: 'DELETE' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await h.api('POST', '/auth/login', { body: { login: u.username, password: 'Testpass1' } })).status, 401);
});

test('a listener can export their data', async () => {
  const u = await h.newUser();
  const r = await h.api('GET', '/me/export', { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.username, u.username);
  assert.ok(!JSON.stringify(r.body).includes('password_hash'), 'never includes the password hash');
});

test('protected routes need a valid token', async () => {
  assert.equal((await h.api('GET', '/songs')).status, 401);
  const forged = await h.api('GET', '/songs', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.invalid' });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error.code, 'TOKEN_INVALID');
});

test('a deactivated account loses access immediately', async () => {
  const u = await h.newUser({ onboard: false });
  await h.query('UPDATE users SET is_active = 0 WHERE user_id = ?', [u.id]);
  const r = await h.api('GET', '/auth/me', { token: u.token });
  assert.equal(r.status, 401);
});

test('SQL injection in login and search is treated as plain text', async () => {
  const r = await h.api('POST', '/auth/login', { body: { login: "' OR 1=1 -- ", password: 'x' } });
  assert.equal(r.status, 401);
  const token = await h.login('varsha', 'Varsha@27');
  const s = await h.api('GET', `/search?q=${encodeURIComponent("'; DROP TABLE songs; --")}`, { token });
  assert.equal(s.status, 200);
  const songs = await h.one('SELECT COUNT(*) AS n FROM songs');
  assert.ok(songs.n > 0, 'songs table still there');
});

test('saved preferences come back for editing and are used as onboarding weights', async () => {
  const u = await h.newUser();
  const me = await h.api('GET', '/auth/me', { token: u.token });
  assert.equal(me.body.onboarded, true);
  assert.equal(me.body.languages.length, 2);
  const opts = await h.api('GET', '/me/preferences', { token: u.token });
  assert.equal(opts.status, 200);
  assert.equal(opts.body.current.languageIds.length, 2);
  assert.equal(opts.body.current.moodIds.length, 2);
  const g = await h.one(`SELECT ugp.onboarding_weight FROM user_genre_preferences ugp JOIN genres g USING (genre_id)
                          WHERE ugp.user_id = ? AND g.name = 'EDM'`, [u.id]);
  assert.ok(Number(g.onboarding_weight) > 0.9);
  const bad = await h.api('PUT', '/me/preferences', { token: u.token, body: { languageIds: [] } });
  assert.equal(bad.status, 400, 'at least one language is required');
});
