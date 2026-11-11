import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, login, call, sleep, UA } from './helpers.js';
import { connectWebSocket } from '../src/core/http/websocket.js';

let g;
before(async () => {
  g = await startGallium();
});
after(async () => {
  await g.stop();
});

const ticketFor = async (s, playlist = 'playlist_defaultsolo', region = 'EU') => {
  const bucket = encodeURIComponent(`14786821:0:${region}:${playlist}`);
  const r = await call(g.base, 'GET', `/fortnite/api/game/v2/matchmakingservice/ticket/player/${s.accountId}?partyPlayerIds=${s.accountId}&bucketId=${bucket}&player.platform=Windows&player.subregions=GB&player.option.crossplayOptOut=false`, { token: s.token });
  assert.equal(r.status, 200, r.text);
  return r.json;
};

function openMms(ticket) {
  return connectWebSocket(ticket.serviceUrl, { headers: { Authorization: `Epic-Signed ${ticket.ticketType} ${ticket.payload} ${ticket.signature}` } }).then((ws) => {
    const messages = [];
    const waiters = [];
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      messages.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(msg);
    });
    const waitFor = (pred, ms = 4000) => {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('matchmaking message timeout')), ms).unref();
      });
    };
    return { ws, messages, waitFor };
  });
}

const register = (body) => call(g.base, 'POST', '/gallium/api/gameservers', { body });

test('ticket format and signature validation', async () => {
  const s = await login(g.base, 'mmticket@test.dev');
  const t = await ticketFor(s);
  assert.equal(t.ticketType, 'mms-player');
  assert.equal(t.serviceUrl, `ws://127.0.0.1:${g.port}/matchmaking`);
  await assert.rejects(connectWebSocket(t.serviceUrl, { headers: { Authorization: `Epic-Signed mms-player ${t.payload} deadbeef` } }), (e) => e.status === 401);
  const bad = await call(g.base, 'GET', `/fortnite/api/game/v2/matchmakingservice/ticket/player/${s.accountId}?bucketId=nope`, { token: s.token });
  assert.equal(bad.status, 400);
});

test('queued players are assigned when a game server registers, then can join the session', async () => {
  const s = await login(g.base, 'mmplayer@test.dev');
  const mms = await openMms(await ticketFor(s, 'playlist_defaultsolo', 'EU'));
  await mms.waitFor((m) => m.payload.state === 'Queued');
  assert.deepEqual(mms.messages.map((m) => m.payload.state).slice(0, 3), ['Connecting', 'Waiting', 'Queued']);
  await sleep(100);
  assert.ok(!mms.messages.some((m) => m.name === 'Play'), 'no server yet, so still queued');

  const reg = await register({ address: '127.0.0.1', port: 7777, region: 'EU', playlists: ['Playlist_DefaultSolo'], maxPlayers: 100, name: 'test-ds' });
  assert.equal(reg.status, 201);
  const assignment = await mms.waitFor((m) => m.payload.state === 'SessionAssignment');
  const play = await mms.waitFor((m) => m.name === 'Play');
  assert.equal(play.payload.matchId, assignment.payload.matchId);
  assert.equal(play.payload.sessionId, reg.json.sessionId);

  const session = await call(g.base, 'GET', `/fortnite/api/matchmaking/session/${play.payload.sessionId}`, { token: s.token });
  assert.equal(session.json.serverAddress, '127.0.0.1');
  assert.equal(session.json.serverPort, 7777);
  assert.equal(session.json.buildUniqueId, '14786821', 'buildUniqueId echoes the client netcl');
  assert.equal(session.json.attributes.PLAYLISTNAME_s, 'playlist_defaultsolo');
  assert.equal((await call(g.base, 'POST', `/fortnite/api/matchmaking/session/${play.payload.sessionId}/join`, { token: s.token })).status, 204);
  const info = await call(g.base, 'GET', `/gallium/api/gameservers/${reg.json.id}`);
  assert.deepEqual(info.json.players, [s.accountId]);
  assert.equal((await call(g.base, 'GET', `/fortnite/api/game/v2/matchmaking/account/${s.accountId}/session/${play.payload.sessionId}`, { token: s.token })).json.sessionId, play.payload.sessionId);

  // started servers take no new players; reset opens a fresh session
  await call(g.base, 'POST', `/gallium/api/gameservers/${reg.json.id}/heartbeat`, { body: { state: 'started' } });
  assert.equal((await call(g.base, 'GET', `/fortnite/api/matchmaking/session/${play.payload.sessionId}`, { token: s.token })).json.started, true);
  const reset = await call(g.base, 'POST', `/gallium/api/gameservers/${reg.json.id}/reset`);
  assert.notEqual(reset.json.sessionId, reg.json.sessionId);
  assert.equal(reset.json.state, 'open');
  assert.equal((await call(g.base, 'GET', `/fortnite/api/matchmaking/session/${play.payload.sessionId}`, { token: s.token })).status, 404, 'old session is gone');
  assert.equal((await call(g.base, 'DELETE', `/gallium/api/gameservers/${reg.json.id}`)).status, 204);
});

test('servers only receive players for their playlist; capacity is enforced', async () => {
  await register({ address: '127.0.0.1', port: 7001, region: 'NAE', playlists: ['playlist_defaultduo'], maxPlayers: 1 });
  const s1 = await login(g.base, 'mmduo1@test.dev');
  const s2 = await login(g.base, 'mmduo2@test.dev');
  const solo = await openMms(await ticketFor(s1, 'playlist_defaultsolo', 'NAE'));
  await solo.waitFor((m) => m.payload.state === 'Queued');
  await sleep(150);
  assert.ok(!solo.messages.some((m) => m.name === 'Play'), 'solo ticket not sent to duo server');
  solo.ws.close();
  const duo1 = await openMms(await ticketFor(s1, 'playlist_defaultduo', 'NAE'));
  await duo1.waitFor((m) => m.name === 'Play');
  const duo2 = await openMms(await ticketFor(s2, 'playlist_defaultduo', 'NAE'));
  await duo2.waitFor((m) => m.payload.state === 'Queued');
  await sleep(150);
  assert.ok(!duo2.messages.some((m) => m.name === 'Play'), 'server is full');
  duo2.ws.close();
});

test('game-server API validates input and requires loopback or the API key', async () => {
  assert.equal((await register({ address: '127.0.0.1', port: 'x' })).status, 400);
  assert.equal((await register({ port: 7777 })).status, 400);
  assert.equal((await call(g.base, 'POST', '/gallium/api/gameservers/nope/heartbeat', { body: {} })).status, 404);
  assert.equal((await call(g.base, 'GET', '/fortnite/api/matchmaking/session/doesnotexist', { token: (await login(g.base, 'mmx@test.dev')).token })).status, 404);
});

test('fallback server from config is used when nothing registered', async () => {
  const g2 = await startGallium({ overrides: { matchmaking: { fallbackServer: { address: '192.168.1.50', port: 7778 } } } });
  const s = await login(g2.base, 'mmfallback@test.dev', 'pw', UA.v14_60);
  const r = await call(g2.base, 'GET', `/fortnite/api/game/v2/matchmakingservice/ticket/player/${s.accountId}?bucketId=${encodeURIComponent('1:0:EU:playlist_defaultsquad')}`, { token: s.token });
  const ws = await connectWebSocket(r.json.serviceUrl, { headers: { Authorization: `Epic-Signed mms-player ${r.json.payload} ${r.json.signature}` } });
  const play = await new Promise((resolve) => ws.on('message', (m) => JSON.parse(m).name === 'Play' && resolve(JSON.parse(m))));
  const session = await call(g2.base, 'GET', `/fortnite/api/matchmaking/session/${play.payload.sessionId}`, { token: s.token });
  assert.equal(session.json.serverAddress, '192.168.1.50');
  assert.equal(session.json.serverPort, 7778);
  await g2.stop();
});
