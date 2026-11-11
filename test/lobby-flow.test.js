import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, call, login, mcp, profileOf, xmppWs, xmppTcp, UA, FN_CLIENT } from './helpers.js';

/**
 * Replays the login -> lobby request sequence each Fortnite build made in the user's real
 * client logs, and checks every response. This is the closest automated stand-in for
 * "a client reaches the lobby".
 */
const BUILDS = [
  {
    name: 'Cert-CL-3741772 (1.x)', ua: UA.cert, season: 1, adapter: 'season1-3', xmpp: 'tcp-main',
    profiles: ['profile0', 'athena', 'collection_book_people0', 'collection_book_schematics0', 'metadata', 'theater0', 'outpost0'],
    commands: [['GetMcpTimeForLogin', 'profile0'], ['IncrementNamedCounterStat', 'profile0', { counterName: 'LoginCount' }], ['ClientQuestLogin', 'profile0'], ['RefreshExpeditions', 'profile0'], ['IssueFriendCode', 'profile0', { codeTokenType: 'CodeToken:FounderFriendInvite' }], ['UpdateQuestClientObjectives', 'profile0', { advance: [{ statName: 'frontend_test', count: 1, timestampOffset: 0 }] }], ['MarkNewQuestNotificationSent', 'profile0', { itemIds: [] }]],
  },
  {
    name: '3.1', ua: UA.v3_1, season: 3, adapter: 'season1-3', xmpp: 'tcp-main',
    profiles: ['profile0', 'athena'],
    commands: [['IncrementNamedCounterStat', 'profile0', { counterName: 'LoginCount' }], ['ClientQuestLogin', 'athena']],
  },
  {
    name: '4.5', ua: UA.v4_5, season: 4, adapter: 'chapter1', xmpp: 'tcp-main',
    profiles: ['common_public', 'common_core', 'campaign', 'athena', 'collection_book_people0', 'collection_book_schematics0', 'metadata', 'theater0', 'outpost0'],
    commands: [['ClientQuestLogin', 'athena'], ['ClientQuestLogin', 'campaign'], ['RefreshExpeditions', 'campaign'], ['EquipBattleRoyaleCustomization', 'athena', { slotName: 'Dance', itemToSlot: 'AthenaDance:EID_DanceMoves', indexWithinSlot: 1, variantUpdates: [] }], ['BulkEquipBattleRoyaleCustomization', 'athena', { loadoutData: [{ slotName: 'Pickaxe', itemToSlot: 'AthenaPickaxe:DefaultPickaxe', indexWithinSlot: 0 }] }], ['MarkItemSeen', 'athena', { itemIds: ['AthenaGlider:DefaultGlider'] }], ['MarkNewQuestNotificationSent', 'athena', { itemIds: [] }]],
  },
  {
    name: '5.41', ua: UA.v5_41, season: 5, adapter: 'chapter1', xmpp: 'ws-xmpp-port-stream',
    profiles: ['common_public', 'common_core', 'athena'],
    commands: [['ClientQuestLogin', 'athena'], ['EquipBattleRoyaleCustomization', 'athena', { slotName: 'Glider', itemToSlot: 'AthenaGlider:DefaultGlider', indexWithinSlot: 0 }], ['MarkNewQuestNotificationSent', 'athena', { itemIds: [] }]],
  },
  {
    name: '14.60', ua: UA.v14_60, season: 14, adapter: 'chapter2-4', xmpp: 'ws-xmpp-port-stream',
    profiles: ['common_public', 'common_core', 'athena', 'creative', 'collections'],
    commands: [['ClientQuestLogin', 'athena'], ['SetCosmeticLockerSlot', 'athena', { lockerItem: 'sandbox_loadout', category: 'Pickaxe', itemToSlot: 'AthenaPickaxe:DefaultPickaxe', slotIndex: 0, variantUpdates: [], optLockerUseCountOverride: -1 }]],
  },
  {
    name: '21.50', ua: UA.v21_50, season: 21, adapter: 'chapter2-4', xmpp: 'ws-xmpp-port-stream',
    profiles: ['common_core', 'collections', 'athena'],
    commands: [['RedeemRealMoneyPurchases', 'common_core', { appStore: 'EpicPurchasingService', authTokens: [], receiptIds: [], purchaseCorrelationId: '' }]],
  },
  {
    name: '32.00', ua: UA.v32_00, season: 32, adapter: 'chapter5plus', xmpp: 'ws-main-rfc7395',
    profiles: ['common_core', 'collections', 'athena', 'creative'],
    commands: [['ClaimMfaEnabled', 'common_core', { bClaimForStw: false }], ['RedeemRealMoneyPurchases', 'common_core', {}], ['ClientQuestLogin', 'athena']],
    athenaQuery: '&dataOmissionGroup=Locker',
  },
  {
    name: '37.20', ua: UA.v37_20, season: 37, adapter: 'chapter5plus', xmpp: 'ws-main-rfc7395',
    profiles: ['common_core', 'collections', 'athena'],
    commands: [['ClaimMfaEnabled', 'common_core', { bClaimForStw: false }], ['RedeemRealMoneyPurchases', 'common_core', {}], ['ClientQuestLogin', 'athena'], ['MarkItemSeen', 'athena', { itemIds: ['AthenaPickaxe:DefaultPickaxe'] }]],
    athenaQuery: '&dataOmissionGroup=Locker',
  },
];

let g;
before(async () => {
  g = await startGallium();
});
after(async () => {
  await g.stop();
});

for (const build of BUILDS) {
  describe(`login -> lobby flow, Fortnite ${build.name}`, () => {
    let s;
    const req = (method, path, opts = {}) => call(g.base, method, path, { ua: build.ua, token: s?.token, ...opts });

    test('pre-login services', async () => {
      const ls = await req('GET', '/lightswitch/api/service/bulk/status?serviceId=Fortnite');
      assert.equal(ls.status, 200);
      assert.equal(ls.json[0].status, 'UP');
      assert.deepEqual(ls.json[0].allowedActions, ['PLAY', 'DOWNLOAD']);
      const cc = await call(g.base, 'POST', '/account/api/oauth/token', { ua: build.ua, headers: { Authorization: FN_CLIENT }, form: { grant_type: 'client_credentials' } });
      assert.equal(cc.status, 200);
      // Chapter 1 gets 32-hex tokens (1.8 XMPP rejects eg1 JWTs), later builds eg1 tokens.
      assert.match(cc.json.access_token, ['season1-3', 'chapter1'].includes(build.adapter) ? /^[0-9a-f]{32}$/ : /^eg1~/);
      assert.equal(cc.json.account_id, undefined);
      const vc = await req('GET', '/fortnite/api/v2/versioncheck/Windows?version=x');
      assert.deepEqual(vc.json, { type: 'NO_UPDATE' });
      assert.deepEqual((await req('GET', '/fortnite/api/versioncheck?version=x')).json, { type: 'NO_UPDATE' });
    });

    test('password login (auto-register) and session checks', async () => {
      const name = `P${build.season}x${Math.random().toString(36).slice(2, 7)}`;
      s = await login(g.base, `${name}@atlas.dev`, 'Rebooted', build.ua);
      assert.equal(s.displayName, name);
      assert.match(s.accountId, /^[0-9a-f]{32}$/);
      assert.equal(s.raw.token_type, 'bearer');
      assert.ok(s.raw.expires_in > 0 && s.raw.refresh_expires > 0);
      const verify = await req('GET', '/account/api/oauth/verify');
      assert.equal(verify.status, 200);
      assert.equal(verify.json.account_id, s.accountId);
      assert.equal(verify.json.display_name, name);
      assert.equal((await req('DELETE', '/account/api/oauth/sessions/kill?killType=OTHERS_ACCOUNT_CLIENT_SERVICE')).status, 204);
      const acct = await req('GET', `/account/api/public/account/${s.accountId}`);
      assert.equal(acct.json.displayName, name);
      assert.equal(acct.json.email, `${name}@atlas.dev`);
      assert.deepEqual((await req('GET', `/account/api/public/account/${s.accountId}/externalAuths`)).json, []);
      assert.deepEqual((await req('GET', '/account/api/epicdomains/ssodomains')).json, []);
    });

    test('startup data: features, cloud storage, catalog, timeline, content', async () => {
      assert.deepEqual((await req('GET', '/fortnite/api/game/v2/enabled_features')).json, []);
      const sys = await req('GET', '/fortnite/api/cloudstorage/system');
      assert.equal(sys.status, 200);
      assert.ok(Array.isArray(sys.json));
      assert.equal((await req('GET', '/fortnite/api/cloudstorage/system/config')).status, 204);
      assert.deepEqual((await req('GET', `/fortnite/api/cloudstorage/user/${s.accountId}`)).json, []);
      const settings = Buffer.from('fake-client-settings-blob');
      assert.equal((await req('PUT', `/fortnite/api/cloudstorage/user/${s.accountId}/ClientSettings.Sav`, { raw: settings })).status, 204);
      const list = await req('GET', `/fortnite/api/cloudstorage/user/${s.accountId}`);
      assert.equal(list.json[0].filename, 'ClientSettings.Sav');
      assert.equal(list.json[0].length, settings.length);
      assert.deepEqual((await req('GET', `/fortnite/api/cloudstorage/user/${s.accountId}/ClientSettings.Sav`)).buffer, settings);

      const play = await req('POST', `/fortnite/api/game/v2/tryPlayOnPlatform/account/${s.accountId}?platform=PC`);
      assert.equal(play.text, 'true');
      assert.equal((await req('POST', `/fortnite/api/game/v2/grant_access/${s.accountId}`)).status, 204);
      assert.deepEqual((await req('GET', `/fortnite/api/receipts/v1/account/${s.accountId}/receipts`)).json, []);
      const cat = await req('GET', '/fortnite/api/storefront/v2/catalog');
      assert.equal(cat.status, 200);
      assert.deepEqual(cat.json.storefronts.map((f) => f.name).slice(0, 2), ['BRWeeklyStorefront', 'BRDailyStorefront']);
      // 5.41 aborts login on an empty keychain ("Unable to parse json"), so it is never empty.
      const keys = (await req('GET', '/fortnite/api/storefront/v2/keychain?numKeysDownloaded=0&rvn=1')).json;
      assert.ok(Array.isArray(keys) && keys.length > 0);
      for (const k of keys) assert.match(k, /^[0-9A-F]{32}:[A-Za-z0-9+/=]+:/i);
      assert.ok(!keys[0].startsWith('0'.repeat(32)), 'never the zero GUID used by unencrypted paks');
      const tl = await req('GET', '/fortnite/api/calendar/v1/timeline');
      const state = tl.json.channels['client-events'].states[0];
      assert.equal(state.state.seasonNumber, build.season);
      assert.equal(state.state.seasonTemplateId, `AthenaSeason:athenaseason${build.season}`);
      assert.ok(state.activeEvents.some((e) => e.eventType === `EventFlag.Season${build.season}`));
      const pages = await req('GET', '/content/api/pages/fortnite-game');
      assert.equal(pages.status, 200);
      assert.ok(pages.json.battleroyalenews.news.motds.length > 0);
      const priv = await req('GET', `/fortnite/api/game/v2/privacy/account/${s.accountId}`);
      assert.equal(priv.json.optOutOfPublicLeaderboards, false);
    });

    test('profiles load and login commands succeed', async () => {
      const seen = {};
      for (const profileId of build.profiles) {
        const extra = profileId === 'athena' ? build.athenaQuery || '' : '';
        const r = await mcp(g.base, s, 'QueryProfile', profileId, {}, { ua: build.ua, extraQuery: extra });
        assert.equal(r.status, 200, `QueryProfile ${profileId}: ${r.text}`);
        assert.equal(r.json.profileId, profileId);
        const p = profileOf(r);
        assert.ok(p, `full profile for ${profileId}`);
        assert.equal(p.accountId, s.accountId);
        assert.equal(typeof p.rvn, 'number');
        assert.equal(r.json.profileCommandRevision, p.commandRevision);
        seen[profileId] = p;
      }
      const athena = seen.athena;
      assert.equal(athena.stats.attributes.season_num, build.season);
      assert.ok(athena.items['AthenaPickaxe:DefaultPickaxe']);
      const hasLocker = Object.values(athena.items).some((i) => i.templateId.startsWith('CosmeticLocker:'));
      // 14.60 uses SetCosmeticLockerSlot; Chapter 5 omits the locker item via dataOmissionGroup=Locker.
      assert.equal(hasLocker, build.adapter === 'chapter2-4');
      if (seen.common_core) assert.ok(seen.common_core.items['Currency:MtxPurchased']);
      if (build.adapter === 'season1-3') assert.equal(seen.profile0.items['Currency:MtxPurchased'].quantity, 1000);

      for (const [command, profileId, body] of build.commands) {
        const prof = seen[profileId] ? (await mcp(g.base, s, 'QueryProfile', profileId, {}, { ua: build.ua })).json : null;
        const rvn = prof ? prof.profileCommandRevision : -1;
        const r = await mcp(g.base, s, command, profileId, body || {}, { ua: build.ua, rvn });
        assert.equal(r.status, 200, `${command} on ${profileId}: ${r.text}`);
        assert.equal(r.json.profileId, profileId);
        assert.ok(Array.isArray(r.json.profileChanges));
        if (prof && r.json.profileChanges.length) assert.notEqual(r.json.profileChanges[0].changeType, 'fullProfileUpdate', `${command} should send deltas when rvn matches`);
      }
    });

    test('social: friends, party and XMPP presence', async () => {
      assert.deepEqual((await req('GET', `/friends/api/public/friends/${s.accountId}?includePending=true`)).json, []);
      const summary = await req('GET', `/friends/api/v1/${s.accountId}/summary`);
      assert.deepEqual(summary.json.friends, []);
      assert.deepEqual((await req('GET', `/friends/api/public/blocklist/${s.accountId}`)).json, { blockedUsers: [] });
      assert.equal((await req('GET', `/friends/api/v1/${s.accountId}/settings`)).status, 200);
      assert.deepEqual((await req('GET', `/party/api/v1/Fortnite/user/${s.accountId}`)).json, { current: [], pending: [], invites: [], pings: [] });
      const party = await req('POST', '/party/api/v1/Fortnite/parties', { body: { config: { join_confirmation: false, joinability: 'OPEN', max_size: 16 }, join_info: { connection: { id: `${s.accountId}@prod.ol.epicgames.com/V2:Fortnite:WIN::X`, meta: { 'urn:epic:conn:platform_s': 'WIN' } }, meta: { 'urn:epic:member:dn_s': s.displayName } }, meta: { 'urn:epic:cfg:party-type-id_s': 'default' } } });
      assert.equal(party.status, 200);
      assert.equal(party.json.members[0].role, 'CAPTAIN');
      assert.equal((await req('GET', `/party/api/v1/Fortnite/user/${s.accountId}`)).json.current[0].id, party.json.id);

      let client;
      if (build.xmpp === 'tcp-main') client = await xmppTcp(g.port, s);
      else if (build.xmpp === 'ws-xmpp-port-stream') client = await xmppWsStream(g.xmppPort, s);
      else client = await xmppWs(g.port, s);
      assert.ok(!client.failed, 'XMPP auth');
      assert.ok(client.jid.startsWith(`${s.accountId}@prod.ol.epicgames.com/`));
      client.send('<presence><status>{"Status":"Battle Royale Lobby - 1 / 16"}</status></presence>');
      client.send('<iq id="ping1" type="get"><ping xmlns="urn:xmpp:ping"/></iq>');
      await client.inbox.wait((n) => n.local === 'iq' && n.attrs.id === 'ping1' && n.attrs.type === 'result');
      client.close();
    });

    test('post-login checks', async () => {
      const events = await req('GET', `/api/v1/events/Fortnite/download/${s.accountId}`);
      assert.equal(events.json.player.accountId, s.accountId);
      assert.deepEqual((await req('GET', `/socialban/api/public/v1/${s.accountId}`)).json, { bans: [], warnings: [] });
      assert.equal((await req('GET', `/eulatracking/api/public/agreements/fn/account/${s.accountId}`)).status, 204);
      assert.equal((await req('GET', '/waitingroom/api/waitingroom')).status, 204);
      const stats = await req('GET', `/fortnite/api/statsv2/account/${s.accountId}`);
      assert.equal(stats.json.accountId, s.accountId);
    });
  });
}

/** WebSocket carrying a classic <stream:stream>, the way 5.41-21.50 talk to ws://127.0.0.1:5222. */
async function xmppWsStream(port, session) {
  const { connectWebSocket } = await import('../src/core/http/websocket.js');
  const { parseXml, XmlStreamSplitter } = await import('../src/core/xml.js');
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/`, { protocols: ['xmpp'] });
  const items = [];
  const waiters = [];
  const splitter = new XmlStreamSplitter();
  ws.on('message', (t) => {
    for (const ev of splitter.push(String(t))) {
      if (ev.type !== 'stanza') continue;
      const node = parseXml(ev.xml);
      const w = waiters.find((x) => x.pred(node));
      if (w) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(node);
      } else items.push(node);
    }
  });
  const inbox = {
    wait: (pred) => {
      const i = items.findIndex(pred);
      if (i !== -1) return Promise.resolve(items.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('timeout')), 3000).unref();
      });
    },
  };
  const send = (x) => ws.send(x);
  const header = "<?xml version='1.0'?><stream:stream to='prod.ol.epicgames.com' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>";
  send(header);
  await inbox.wait((n) => n.local === 'features');
  send(`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${Buffer.from(`\0${session.accountId}\0${session.token}`).toString('base64')}</auth>`);
  const res = await inbox.wait((n) => n.local === 'success' || n.local === 'failure');
  if (res.local === 'failure') return { failed: true };
  send(header);
  await inbox.wait((n) => n.local === 'features' && n.child('bind'));
  send("<iq id='b1' type='set'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>V2:Fortnite:WIN::WS</resource></bind></iq>");
  const bound = await inbox.wait((n) => n.local === 'iq' && n.attrs.id === 'b1');
  return { inbox, send, jid: bound.child('bind').childText('jid'), close: () => ws.close() };
}
