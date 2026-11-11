import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startGallium, call, login, FN_CLIENT, UA } from './helpers.js';
import { ListenError } from '../src/server.js';

let g;
before(async () => {
  g = await startGallium();
});
after(async () => {
  await g.stop();
});

const token = (form) => call(g.base, 'POST', '/account/api/oauth/token', { headers: { Authorization: FN_CLIENT }, form });

test('server listens on its port and answers health', async () => {
  await new Promise((resolve, reject) => net.connect(g.port, '127.0.0.1').once('connect', function () { this.end(); resolve(); }).once('error', reject));
  const h = await call(g.base, 'GET', '/gallium/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.status, 'ok');
});

test('port already in use is reported clearly', async () => {
  await assert.rejects(startGallium({ overrides: { server: { port: g.port } } }), (err) => err instanceof ListenError && err.code === 'EADDRINUSE' && /already in use/.test(err.message));
});

test('unknown routes return Epic-style 404s, wrong methods 405', async () => {
  const r = await call(g.base, 'GET', '/does/not/exist');
  assert.equal(r.status, 404);
  assert.equal(r.json.errorCode, 'errors.com.epicgames.common.not_found');
  assert.equal(r.json.numericErrorCode, 1004);
  assert.equal(r.headers.get('x-epic-error-name'), 'errors.com.epicgames.common.not_found');
  assert.equal((await call(g.base, 'PUT', '/lightswitch/api/service/bulk/status')).status, 405);
});

test('protected routes require a valid token', async () => {
  const r = await call(g.base, 'GET', '/account/api/oauth/verify');
  assert.equal(r.status, 401);
  assert.equal(r.json.errorCode, 'errors.com.epicgames.common.authentication.authentication_failed');
  const bad = await call(g.base, 'GET', '/account/api/oauth/verify', { token: 'eg1~not.a.token' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.numericErrorCode, 1014);
});

test('invalid JSON bodies are rejected with 400', async () => {
  const s = await login(g.base, 'jsonbad@test.dev');
  const r = await call(g.base, 'POST', `/fortnite/api/game/v2/profile/${s.accountId}/client/QueryProfile?profileId=athena`, { token: s.token, raw: '{oops', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.errorCode, 'errors.com.epicgames.validation.validation_failed');
});

test('password grant: auto-register, then the password is enforced', async () => {
  const first = await token({ grant_type: 'password', username: 'alice@atlas.dev', password: 'secret1' });
  assert.equal(first.status, 200);
  assert.equal(first.json.displayName, 'alice');
  const again = await token({ grant_type: 'password', username: 'alice@atlas.dev', password: 'secret1' });
  assert.equal(again.json.account_id, first.json.account_id);
  const wrong = await token({ grant_type: 'password', username: 'alice@atlas.dev', password: 'nope' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.errorCode, 'errors.com.epicgames.account.invalid_account_credentials');
  assert.equal(wrong.json.error, 'invalid_grant');
  const byName = await token({ grant_type: 'password', username: 'alice', password: 'secret1' });
  assert.equal(byName.json.account_id, first.json.account_id);
});

test('missing / unsupported grants are rejected', async () => {
  assert.equal((await token({})).status, 400);
  const r = await token({ grant_type: 'otp' });
  assert.equal(r.json.errorCode, 'errors.com.epicgames.common.oauth.unsupported_grant_type');
  assert.equal((await token({ grant_type: 'password', username: 'x@y.z' })).status, 400);
});

test('refresh_token grant rotates the session', async () => {
  const s = await login(g.base, 'refresh@test.dev');
  const r = await token({ grant_type: 'refresh_token', refresh_token: s.refresh });
  assert.equal(r.status, 200);
  assert.equal(r.json.account_id, s.accountId);
  assert.notEqual(r.json.access_token, s.token);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: s.token })).status, 401, 'old session is gone');
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: s.refresh })).status, 400, 'refresh token is single use');
});

test('exchange codes are single-use', async () => {
  const s = await login(g.base, 'exch@test.dev');
  const ex = await call(g.base, 'GET', '/account/api/oauth/exchange', { token: s.token });
  assert.match(ex.json.code, /^[0-9a-f]{32}$/);
  const r = await token({ grant_type: 'exchange_code', exchange_code: ex.json.code });
  assert.equal(r.json.account_id, s.accountId);
  const reuse = await token({ grant_type: 'exchange_code', exchange_code: ex.json.code });
  assert.equal(reuse.json.errorCode, 'errors.com.epicgames.account.oauth.exchange_code_not_found');
});

test('device auth create, login and delete', async () => {
  const s = await login(g.base, 'device@test.dev');
  const d = await call(g.base, 'POST', `/account/api/public/account/${s.accountId}/deviceAuth`, { token: s.token });
  assert.equal(d.json.accountId, s.accountId);
  const r = await token({ grant_type: 'device_auth', account_id: s.accountId, device_id: d.json.deviceId, secret: d.json.secret });
  assert.equal(r.json.account_id, s.accountId);
  assert.equal((await token({ grant_type: 'device_auth', account_id: s.accountId, device_id: d.json.deviceId, secret: 'wrong' })).status, 400);
  assert.equal((await call(g.base, 'GET', `/account/api/public/account/${s.accountId}/deviceAuth`, { token: s.token })).json.length, 1);
  assert.equal((await call(g.base, 'DELETE', `/account/api/public/account/${s.accountId}/deviceAuth/${d.json.deviceId}`, { token: s.token })).status, 204);
});

test('killing other sessions keeps the current one', async () => {
  const a = await login(g.base, 'kill@test.dev');
  const b = await login(g.base, 'kill@test.dev');
  assert.equal((await call(g.base, 'DELETE', '/account/api/oauth/sessions/kill?killType=OTHERS_ACCOUNT_CLIENT_SERVICE', { token: b.token })).status, 204);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: a.token })).status, 401);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: b.token })).status, 200);
  assert.equal((await call(g.base, 'DELETE', `/account/api/oauth/sessions/kill/${encodeURIComponent(b.token)}`)).status, 204);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: b.token })).status, 401);
});

test('banned accounts cannot log in and lightswitch reports the ban', async () => {
  const s = await login(g.base, 'banme@test.dev', 'pw');
  g.services.admin.setBanned(s.accountId, true);
  const r = await token({ grant_type: 'password', username: 'banme@test.dev', password: 'pw' });
  assert.equal(r.json.errorCode, 'errors.com.epicgames.account.account_not_active');
  g.services.admin.setBanned(s.accountId, false);
  const ok = await login(g.base, 'banme@test.dev', 'pw');
  const ls = await call(g.base, 'GET', '/lightswitch/api/service/bulk/status', { token: ok.token });
  assert.equal(ls.json[0].banned, false);
});

test('account lookups and other-account access control', async () => {
  const a = await login(g.base, 'lookA@test.dev');
  const b = await login(g.base, 'lookB@test.dev');
  const many = await call(g.base, 'GET', `/account/api/public/account?accountId=${a.accountId}&accountId=${b.accountId}`, { token: a.token });
  assert.deepEqual(many.json.map((x) => x.displayName).sort(), ['lookA', 'lookB']);
  const other = await call(g.base, 'GET', `/account/api/public/account/${b.accountId}`, { token: a.token });
  assert.equal(other.json.email, undefined, 'no private fields for other accounts');
  assert.equal((await call(g.base, 'GET', `/account/api/public/account/displayName/lookB`, { token: a.token })).json.id, b.accountId);
  assert.equal((await call(g.base, 'GET', `/account/api/public/account/${'f'.repeat(32)}`, { token: a.token })).status, 404);
  const forbidden = await call(g.base, 'GET', `/fortnite/api/cloudstorage/user/${b.accountId}`, { token: a.token });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.errorCode, 'errors.com.epicgames.common.missing_permission');
});

test('version endpoint reports the adapter picked for a build', async () => {
  const r = await call(g.base, 'GET', '/gallium/api/version', { ua: UA.v4_5 });
  assert.equal(r.json.adapter, 'chapter1');
  assert.equal((await call(g.base, 'GET', '/gallium/api/version?build=32.00')).json.adapter, 'chapter5plus');
});
