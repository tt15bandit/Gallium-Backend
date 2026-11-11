import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGallium, login, call, xmppTcp, UA } from './helpers.js';

let g;
before(async () => {
  g = await startGallium();
});
after(async () => {
  await g.stop();
});

async function hotfix(s, ua) {
  const list = (await call(g.base, 'GET', '/fortnite/api/cloudstorage/system', { token: s.token, ua })).json;
  const entry = list.find((f) => f.filename === 'DefaultEngine.ini');
  if (!entry) return { entry: null, text: null };
  const file = await call(g.base, 'GET', `/fortnite/api/cloudstorage/system/${entry.uniqueFilename}`, { token: s.token, ua });
  assert.equal(file.status, 200);
  assert.equal(file.buffer.length, entry.length, 'listed length matches the file');
  return { entry, text: file.text };
}

const setting = (text, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1].trim();

test('Season 1: the hotfix points XMPP at Gallium over raw TCP, and that address logs in', async () => {
  const s = await login(g.base, 's1hotfix@atlas.dev', 'Rebooted', UA.cert);
  const { text } = await hotfix(s, UA.cert);
  assert.ok(text, 'DefaultEngine.ini is served to 1.x');
  assert.match(text, /^\[OnlineSubsystemMcp\.Xmpp\]/m);
  assert.match(text, /^\[OnlineSubsystemMcp\.Xmpp Prod\]/m);
  assert.equal(setting(text, 'bUseSSL'), 'false');
  assert.equal(setting(text, 'ServerAddr'), '"127.0.0.1"');
  const port = Number(setting(text, 'ServerPort'));
  assert.equal(port, g.xmppPort, 'straight to the XMPP listener, not through an HTTP-only launcher proxy');
  const client = await xmppTcp(port, s);
  assert.ok(!client.failed);
  assert.ok(client.jid.startsWith(`${s.accountId}@prod.ol.epicgames.com/`));
  client.close();
});

test('XMPP transport in the hotfix follows the build', async () => {
  const expect = [
    [UA.v3_1, '"127.0.0.1"'],
    [UA.v4_5, '"127.0.0.1"'],
    [UA.v5_41, '"ws://127.0.0.1"'],
    [UA.v14_60, '"ws://127.0.0.1"'],
    [UA.v21_50, '"ws://127.0.0.1"'],
  ];
  for (const [ua, addr] of expect) {
    const s = await login(g.base, `hf${Math.random().toString(36).slice(2, 8)}@t.dev`, 'pw', ua);
    assert.equal(setting((await hotfix(s, ua)).text, 'ServerAddr'), addr, ua);
  }
  const c5 = await login(g.base, 'hfc5@t.dev', 'pw', UA.v32_00);
  assert.equal((await hotfix(c5, UA.v32_00)).entry, null, 'Chapter 5 keeps its own XMPP settings');
});

test('user hotfix files are merged, and a user XMPP section wins', async () => {
  const dir = path.join(g.dataDir, 'cloudstorage');
  fs.mkdirSync(dir, { recursive: true });
  const s = await login(g.base, 'hfuser@t.dev', 'pw', UA.cert);
  fs.writeFileSync(path.join(dir, 'DefaultEngine.ini'), '[ConsoleVariables]\r\nFort.ShowDebugInfo=0\r\n');
  let { text } = await hotfix(s, UA.cert);
  assert.match(text, /^\[ConsoleVariables\]/m, 'user content kept');
  assert.match(text, /^\[OnlineSubsystemMcp\.Xmpp\]/m, 'Gallium XMPP section appended');
  const own = '[OnlineSubsystemMcp.Xmpp]\r\nServerAddr="10.0.0.5"\r\nServerPort=6000\r\n';
  fs.writeFileSync(path.join(dir, 'DefaultEngine.ini'), own);
  ({ text } = await hotfix(s, UA.cert));
  assert.equal(text, own, 'user XMPP settings are served unchanged');
  fs.unlinkSync(path.join(dir, 'DefaultEngine.ini'));
});

test('leaderboard cohort contains the player and a near expiry', async () => {
  const s = await login(g.base, 'cohort@t.dev', 'pw', UA.cert);
  const r = await call(g.base, 'GET', `/fortnite/api/game/v2/leaderboards/cohort/${s.accountId}?playlist=pc_m0_p9`, { token: s.token, ua: UA.cert });
  assert.deepEqual(r.json.cohortAccounts, [s.accountId]);
  assert.equal(r.json.playlist, 'pc_m0_p9');
  const ms = Date.parse(r.json.expiresAt) - Date.now();
  assert.ok(ms > 0 && ms <= 86400000);
});
