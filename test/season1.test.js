import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGallium, makeDataDir, login, mcp, profileOf, call, xmppTcp, UA } from './helpers.js';
import { COSMETICS } from './fixtures.js';

/** Season 1 (1.8 / Cert) fixes found from real in-game runs. */
const ITEMS = {
  ...COSMETICS,
  items: [...COSMETICS.items, { id: 'CID_017_Athena_Commando_M', type: 'AthenaCharacter', season: 1, rarity: 'rare', variants: [] }],
};
const SEASON1_SHOP = {
  featured: [{ items: ['AthenaCharacter:CID_028_Athena_Commando_F'], price: 1200 }],
  daily: [{ items: ['AthenaGlider:Glider_ID_001'], price: 500 }],
  season: [
    { items: ['AthenaCharacter:CID_017_Athena_Commando_M'], price: 1200, seasonLevel: 15 },
    { items: ['AthenaPickaxe:Pickaxe_ID_013_Teslacoil'], price: 800, seasonWins: 1 },
  ],
};

let g;
before(async () => {
  g = await startGallium({ dataDir: makeDataDir({ 'cosmetics.json': ITEMS, 'shop/season1.json': SEASON1_SHOP, 'shop.json': { featured: [{ items: ['AthenaDance:EID_Floss'], price: 500 }] } }) });
});
after(async () => {
  await g.stop();
});

const catalog = async (s, ua = UA.cert) => (await call(g.base, 'GET', '/fortnite/api/storefront/v2/catalog', { token: s.token, ua })).json;
const front = (cat, name) => cat.storefronts.find((f) => f.name === name)?.catalogEntries || [];

test('Chapter 1 builds get 32-hex tokens that work for HTTP and XMPP; later builds keep eg1', async () => {
  const s = await login(g.base, 's1token@atlas.dev', 'Rebooted', UA.cert);
  assert.match(s.token, /^[0-9a-f]{32}$/);
  assert.match(s.refresh, /^[0-9a-f]{32}$/);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: s.token, ua: UA.cert })).json.account_id, s.accountId);
  const x = await xmppTcp(g.xmppPort, s);
  assert.ok(!x.failed, 'XMPP accepts the legacy token');
  x.close();
  const r = await call(g.base, 'POST', '/account/api/oauth/token', { ua: UA.cert, form: { grant_type: 'refresh_token', refresh_token: s.refresh } });
  assert.match(r.json.access_token, /^[0-9a-f]{32}$/);
  assert.match((await login(g.base, 's14token@atlas.dev', 'pw', UA.v14_60)).token, /^eg1~/);
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: 'f'.repeat(32) })).status, 401, 'unknown hex token rejected');
});

test('each season has its own shop file, falling back to data/shop.json', async () => {
  const s1 = await login(g.base, 's1shop@atlas.dev', 'pw', UA.cert);
  const cat = await catalog(s1);
  assert.deepEqual(front(cat, 'BRWeeklyStorefront').map((e) => e.itemGrants[0].templateId), ['AthenaCharacter:CID_028_Athena_Commando_F']);
  assert.deepEqual(front(cat, 'BRDailyStorefront').map((e) => e.itemGrants[0].templateId), ['AthenaGlider:Glider_ID_001']);
  const s3 = await login(g.base, 's3shop@atlas.dev', 'pw', UA.v3_1);
  const cat3 = await catalog(s3, UA.v3_1);
  assert.deepEqual(front(cat3, 'BRWeeklyStorefront').map((e) => e.itemGrants[0].templateId), ['AthenaDance:EID_Floss'], 'season 3 uses data/shop.json');
  assert.equal(front(cat3, 'BRDailyStorefront').length, 0, 'no random rotation unless enabled');
});

test('Season Shop (BRSeasonStorefront) offers carry SeasonLevelReq / SeasonWinsReq and are enforced', async () => {
  const s = await login(g.base, 's1season@atlas.dev', 'pw', UA.cert);
  g.services.admin.setVbucks(s.accountId, 5000);
  const season = front(await catalog(s), 'BRSeasonStorefront');
  assert.equal(season.length, 2);
  const trooper = season.find((e) => e.itemGrants[0].templateId === 'AthenaCharacter:CID_017_Athena_Commando_M');
  assert.deepEqual(trooper.metaInfo, [{ key: 'SeasonLevelReq', value: '15' }]);
  const pickaxe = season.find((e) => e.itemGrants[0].templateId.startsWith('AthenaPickaxe'));
  assert.deepEqual(pickaxe.metaInfo, [{ key: 'SeasonWinsReq', value: '1' }]);

  const buy = (offer) => mcp(g.base, s, 'PurchaseCatalogEntry', 'profile0', { offerId: offer.offerId, purchaseQuantity: 1, currency: 'MtxCurrency', expectedTotalPrice: offer.prices[0].finalPrice }, { ua: UA.cert });
  const locked = await buy(trooper);
  assert.equal(locked.status, 400);
  assert.match(locked.json.errorMessage, /season level 15/);
  g.services.admin.addXp(s.accountId, 80000 * 14, 'Cert-CL-3741772');
  const athena = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.cert }));
  assert.equal(athena.stats.attributes.level, 15);
  assert.equal(athena.stats.attributes.season_level, 15, 'season_level mirrors level for 1.x');
  const ok = await buy(trooper);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'profile0', {}, { ua: UA.cert })).items['Currency:MtxPurchased'].quantity, 3800, 'profile0 balance mirrors the charge');
  assert.match((await buy(pickaxe)).json.errorMessage, /1 season wins/);
  const gs = (await call(g.base, 'POST', '/gallium/api/gameservers', { body: { address: '127.0.0.1', port: 7777 } })).json;
  await call(g.base, 'POST', `/gallium/api/gameservers/${gs.id}/results`, { body: { players: [{ accountId: s.accountId, placement: 1 }] } });
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.cert })).stats.attributes.season_wins, 1);
  assert.equal((await buy(pickaxe)).status, 200);
});

test('news has the fields 1.8 reads, and the image is served', async () => {
  const s = await login(g.base, 's1news@atlas.dev', 'pw', UA.cert);
  const pages = (await call(g.base, 'GET', '/content/api/pages/fortnite-game', { ua: UA.cert })).json;
  const msg = pages.battleroyalenews.news.messages[0];
  assert.equal(msg.messageType, 'normal');
  assert.equal(msg._type, 'CommonUI Simple Message Base');
  assert.match(msg.image, new RegExp(`^http://127\\.0\\.0\\.1:${g.port}/gallium/assets/news\\.png`));
  const img = await call(g.base, 'GET', new URL(msg.image).pathname);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual([...img.buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.mkdirSync(path.join(g.dataDir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(g.dataDir, 'content', 'news-season1.json'), JSON.stringify([{ title: 'Welcome', body: 'Season 1 is live' }, { title: 'Second', body: 'two', image: 'http://example.invalid/a.png' }]));
  const custom = (await call(g.base, 'GET', '/content/api/pages/fortnite-game', { ua: UA.cert })).json.battleroyalenews.news.messages;
  assert.deepEqual(custom.map((m) => m.title), ['Welcome', 'Second']);
  assert.equal(custom[1].image, 'http://example.invalid/a.png');
  void s;
});

test('global chat rooms endpoint (1.x) and the shared MUC room', async () => {
  const s = await login(g.base, 's1chat@atlas.dev', 'pw', UA.cert);
  const r = await call(g.base, 'GET', `/fortnite/api/game/v2/chat/${s.accountId}/recommendGeneralChatRooms/athena/pc`, { token: s.token, ua: UA.cert });
  assert.deepEqual(r.json.globalChatRooms, [{ roomName: 'fortnite' }]);
  assert.equal(r.json.bIsGlobalChatDisabled, false);
});

test('addresses handed to clients follow the interface they connected on (Radmin/LAN friends)', async () => {
  const s = await login(g.base, 's1addr@atlas.dev', 'pw', UA.cert);
  const ini = (await call(g.base, 'GET', '/fortnite/api/cloudstorage/system/DefaultEngine.ini', { token: s.token, ua: UA.cert })).text;
  assert.match(ini, /ServerAddr="127\.0\.0\.1"/);
  // Same request arriving on another interface: the hotfix names that interface's address.
  const svc = g.services.cloudStorage.readSystem(g.services.versions.resolve(UA.cert), 'DefaultEngine.ini', '26.236.245.101').toString();
  assert.match(svc, /ServerAddr="26\.236\.245\.101"/);
  const t = g.services.matchmaking.createTicket(s.accountId, { bucketId: '1:0:EU:playlist_defaultsolo' }, '26.236.245.101:1523');
  assert.equal(t.serviceUrl, 'ws://26.236.245.101:1523/matchmaking');
});
