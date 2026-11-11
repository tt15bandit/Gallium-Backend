import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, login, call, xmppWs, xmppTcp, sleep } from './helpers.js';

let g;
before(async () => {
  g = await startGallium({ partyDisconnectGraceMs: 200 });
});
after(async () => {
  await g.stop();
});

test('XMPP rejects a bad token', async () => {
  const s = await login(g.base, 'xbad@test.dev');
  const r = await xmppWs(g.port, { accountId: s.accountId, token: 'eg1~forged.token.value' });
  assert.equal(r.failed, true);
});

test('XMPP: raw TCP works on both the main port and the XMPP port', async () => {
  const s = await login(g.base, 'xtcp@test.dev');
  for (const port of [g.port, g.xmppPort]) {
    const c = await xmppTcp(port, s);
    assert.ok(c.jid.startsWith(s.accountId));
    c.send('<iq id="p" type="get"><ping xmlns="urn:xmpp:ping"/></iq>');
    await c.inbox.wait((n) => n.attrs.id === 'p');
    c.close();
  }
});

test('friend request over HTTP, notifications and presence over XMPP', async () => {
  const a = await login(g.base, 'fa@test.dev');
  const b = await login(g.base, 'fb@test.dev');
  const xa = await xmppWs(g.port, a);
  const xb = await xmppWs(g.xmppPort, b);
  xa.send('<presence><status>{"Status":"In Lobby"}</status></presence>');
  xb.send('<presence><status>{"Status":"Also Lobby"}</status></presence>');

  assert.equal((await call(g.base, 'POST', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token })).status, 204);
  const incoming = await xb.inbox.json('FRIENDSHIP_REQUEST');
  assert.equal(incoming.from, a.accountId);
  assert.equal(incoming.status, 'PENDING');
  const legacy = await xb.inbox.json('com.epicgames.friends.core.apiobjects.Friend');
  assert.equal(legacy.payload.direction, 'INBOUND');
  assert.equal((await call(g.base, 'GET', `/friends/api/v1/${b.accountId}/summary`, { token: b.token })).json.incoming[0].accountId, a.accountId);

  // accept (old API), then presences are exchanged
  assert.equal((await call(g.base, 'POST', `/friends/api/public/friends/${b.accountId}/${a.accountId}`, { token: b.token })).status, 204);
  const accepted = await xa.inbox.json('FRIENDSHIP_REQUEST', (n) => n.status === 'ACCEPTED');
  assert.deepEqual([accepted.from, accepted.to], [a.accountId, b.accountId], 'the request a -> b was accepted');
  const pres = await xa.inbox.wait((n) => n.local === 'presence' && n.attrs.from?.startsWith(b.accountId));
  assert.match(pres.childText('status'), /Also Lobby/);
  const friendsA = (await call(g.base, 'GET', `/friends/api/public/friends/${a.accountId}`, { token: a.token })).json;
  assert.deepEqual(friendsA.map((f) => [f.accountId, f.status]), [[b.accountId, 'ACCEPTED']]);

  // whisper routing
  xa.send(`<message to="${b.accountId}@prod.ol.epicgames.com" type="chat"><body>hello</body></message>`);
  const msg = await xb.inbox.wait((n) => n.local === 'message' && n.attrs.type === 'chat');
  assert.equal(msg.childText('body'), 'hello');
  assert.ok(msg.attrs.from.startsWith(a.accountId));

  // removal notifies both sides
  assert.equal((await call(g.base, 'DELETE', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token })).status, 204);
  assert.equal((await xb.inbox.json('FRIENDSHIP_REMOVE')).to, a.accountId);
  assert.equal((await call(g.base, 'DELETE', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token })).status, 404);
  assert.equal((await call(g.base, 'POST', `/friends/api/v1/${a.accountId}/friends/${a.accountId}`, { token: a.token })).status, 400);
  // blocking
  await call(g.base, 'POST', `/friends/api/v1/${a.accountId}/blocklist/${b.accountId}`, { token: a.token });
  assert.deepEqual((await call(g.base, 'GET', `/friends/api/public/blocklist/${a.accountId}`, { token: a.token })).json.blockedUsers, [b.accountId]);
  assert.equal((await call(g.base, 'POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token })).status, 404, 'blocked users cannot send requests');
  xa.close();
  xb.close();
});

test('party lifecycle: create, invite, join, meta updates, promote, leave', async () => {
  const a = await login(g.base, 'pa@test.dev');
  const b = await login(g.base, 'pb@test.dev');
  const xa = await xmppWs(g.port, a);
  const xb = await xmppWs(g.port, b);
  const P = '/party/api/v1/Fortnite';
  const party = (await call(g.base, 'POST', `${P}/parties`, { token: a.token, body: { config: { max_size: 4 }, join_info: { connection: { id: xa.jid, meta: {} }, meta: { 'urn:epic:member:dn_s': 'pa' } }, meta: {} } })).json;
  assert.equal(party.config.max_size, 4);

  assert.equal((await call(g.base, 'POST', `${P}/parties/${party.id}/invites/${b.accountId}?sendPing=true`, { token: a.token, body: { 'urn:epic:invite:platformdata_s': '' } })).status, 204);
  const invite = await xb.inbox.json('com.epicgames.social.party.notification.v0.INITIAL_INVITE');
  assert.equal(invite.party_id, party.id);
  assert.equal(invite.inviter_id, a.accountId);
  await xb.inbox.json('com.epicgames.social.party.notification.v0.PING');
  assert.equal((await call(g.base, 'GET', `${P}/user/${b.accountId}`, { token: b.token })).json.invites.length, 1);
  assert.equal((await call(g.base, 'GET', `${P}/user/${b.accountId}/pings/${a.accountId}/parties`, { token: b.token })).json[0].id, party.id);

  const join = await call(g.base, 'POST', `${P}/parties/${party.id}/members/${b.accountId}/join`, { token: b.token, body: { connection: { id: xb.jid, meta: {} }, meta: { 'urn:epic:member:dn_s': 'pb' } } });
  assert.deepEqual(join.json, { status: 'JOINED', party_id: party.id });
  const joined = await xa.inbox.json('com.epicgames.social.party.notification.v0.MEMBER_JOINED');
  assert.equal(joined.account_id, b.accountId);
  assert.equal(joined.account_dn, b.displayName);

  assert.equal((await call(g.base, 'PATCH', `${P}/parties/${party.id}/members/${b.accountId}/meta`, { token: b.token, body: { delete: [], update: { 'Default:LobbyState_j': '{"LobbyState":{"readyInputType":"MouseAndKeyboard"}}' }, revision: 0 } })).status, 204);
  const ready = await xa.inbox.json('com.epicgames.social.party.notification.v0.MEMBER_STATE_UPDATED');
  assert.match(ready.member_state_updated['Default:LobbyState_j'], /readyInputType/);
  assert.equal((await call(g.base, 'PATCH', `${P}/parties/${party.id}/members/${a.accountId}/meta`, { token: b.token, body: { update: {} } })).status, 403, 'cannot edit another member');

  assert.equal((await call(g.base, 'PATCH', `${P}/parties/${party.id}`, { token: b.token, body: { meta: { update: { x: '1' } } } })).status, 403, 'only captain updates party');
  assert.equal((await call(g.base, 'PATCH', `${P}/parties/${party.id}`, { token: a.token, body: { config: { joinability: 'INVITE_AND_FORMER' }, meta: { delete: [], update: { 'Default:PlaylistData_j': '{"PlaylistData":{"playlistName":"Playlist_DefaultDuo"}}' } }, revision: 0 } })).status, 204);
  const upd = await xb.inbox.json('com.epicgames.social.party.notification.v0.PARTY_UPDATED');
  assert.equal(upd.party_privacy_type, 'INVITE_AND_FORMER');
  assert.ok(upd.party_state_updated['Default:PlaylistData_j']);

  assert.equal((await call(g.base, 'POST', `${P}/parties/${party.id}/members/${b.accountId}/promote`, { token: a.token })).status, 204);
  assert.equal((await xa.inbox.json('com.epicgames.social.party.notification.v0.MEMBER_NEW_CAPTAIN')).account_id, b.accountId);

  assert.equal((await call(g.base, 'DELETE', `${P}/parties/${party.id}/members/${b.accountId}`, { token: b.token })).status, 204);
  assert.equal((await xa.inbox.json('com.epicgames.social.party.notification.v0.MEMBER_LEFT')).account_id, b.accountId);
  assert.equal((await xa.inbox.json('com.epicgames.social.party.notification.v0.MEMBER_NEW_CAPTAIN')).account_id, a.accountId, 'captaincy returns to the remaining member');
  assert.equal((await call(g.base, 'GET', `${P}/user/${b.accountId}`, { token: b.token })).json.current.length, 0);

  // disconnect removes the last member after the grace period and disbands the party
  xa.close();
  await sleep(500);
  assert.equal((await call(g.base, 'GET', `${P}/parties/${party.id}`, { token: a.token })).status, 404);
  xb.close();
});

test('MUC party chat (older builds) relays groupchat messages', async () => {
  const a = await login(g.base, 'muca@test.dev');
  const b = await login(g.base, 'mucb@test.dev');
  const xa = await xmppTcp(g.port, a);
  const xb = await xmppTcp(g.port, b);
  const room = 'Party-1234@muc.prod.ol.epicgames.com';
  xa.send(`<presence to="${room}/${a.accountId}:${a.accountId}:WIN"><x xmlns="http://jabber.org/protocol/muc"/></presence>`);
  await xa.inbox.wait((n) => n.local === 'presence' && n.attrs.from?.startsWith('Party-1234'));
  xb.send(`<presence to="${room}/${b.accountId}:${b.accountId}:WIN"><x xmlns="http://jabber.org/protocol/muc"/></presence>`);
  await xa.inbox.wait((n) => n.local === 'presence' && n.attrs.from?.endsWith(`${b.accountId}:${b.accountId}:WIN`));
  xb.send(`<message to="${room}" type="groupchat"><body>gg</body></message>`);
  const m = await xa.inbox.wait((n) => n.local === 'message' && n.attrs.type === 'groupchat');
  assert.equal(m.childText('body'), 'gg');
  xa.close();
  xb.close();
});
