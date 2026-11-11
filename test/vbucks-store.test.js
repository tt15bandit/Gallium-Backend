import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, login, mcp, profileOf, call, UA } from './helpers.js';

let g;
before(async () => {
  g = await startGallium();
});
after(async () => {
  await g.stop();
});

const catalog = async (s, ua = UA.cert) => (await call(g.base, 'GET', '/fortnite/api/storefront/v2/catalog', { token: s.token, ua })).json;
const currency = (cat) => cat.storefronts.find((f) => f.name === 'CurrencyStorefront')?.catalogEntries || [];
const balance = async (s) => profileOf(await mcp(g.base, s, 'QueryProfile', 'profile0', {}, { ua: UA.cert })).items['Currency:MtxPurchased'].quantity;

test('STORE tab: CurrencyStorefront lists the 1.8 V-Bucks packs as RealMoney offers', async () => {
  const s = await login(g.base, 'store1@atlas.dev', 'Rebooted', UA.cert);
  const packs = currency(await catalog(s));
  assert.deepEqual(packs.map((p) => p.metaInfo.find((m) => m.key === 'MtxQuantity').value), ['1000', '2800', '7500', '13500']);
  for (const p of packs) {
    assert.equal(p.prices[0].currencyType, 'RealMoney');
    assert.ok(p.prices[0].finalPrice > 0, 'paid price so the purchase browser opens');
    assert.equal(p.appStoreId.length, 12);
    assert.match(p.appStoreId[1], /^[0-9a-f]{32}$/, 'EpicPurchasingService offer id');
    assert.match(p.displayAssetPath, /^\/Game\/Catalog\/DisplayAssets\/DA_MtxPack\d+\.DA_MtxPack\d+$/);
    assert.equal('meta' in p, false);
  }
  const s14 = await login(g.base, 'store14@atlas.dev', 'pw', UA.v14_60);
  assert.equal(currency(await catalog(s14, UA.v14_60)).length, 0, 'only builds with the purchase browser flow');
});

test('catalog bulk offers describe the packs; the price engine has no rules', async () => {
  const s = await login(g.base, 'store2@atlas.dev', 'Rebooted', UA.cert);
  const epicIds = currency(await catalog(s)).map((p) => p.appStoreId[1]);
  const r = await call(g.base, 'GET', `/catalog/api/shared/bulk/offers?${epicIds.map((i) => `id=${i}`).join('&')}&id=unknown&returnItemDetails=true&country=US&locale=en`, { token: s.token, ua: UA.cert });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), [...epicIds].sort());
  const o = r.json[epicIds[0]];
  assert.equal(o.title, '1,000 V-Bucks');
  assert.equal(o.currentPrice, 999);
  assert.equal(o.currencyCode, 'USD');
  assert.equal(o.namespace, 'fn');
  assert.equal((await call(g.base, 'GET', `/catalog/api/shared/bulk/offers?id=${epicIds[0]}`)).status, 401);
  assert.equal((await call(g.base, 'POST', '/priceengine/api/shared/offers/price', { token: s.token, ua: UA.cert, body: { lineOffers: [] } })).status, 404);
});

test('hotfix points the in-game purchase browser at the checkout page', async () => {
  const s = await login(g.base, 'store3@atlas.dev', 'Rebooted', UA.cert);
  const ini = (await call(g.base, 'GET', '/fortnite/api/cloudstorage/system/DefaultGame.ini', { token: s.token, ua: UA.cert })).text;
  assert.match(ini, /^\[EpicPurchaseFlow\]/m);
  assert.match(ini, new RegExp(`^Prod="http://127\\.0\\.0\\.1:${g.port}/gallium/purchase"`, 'm'));
  const page = await call(g.base, 'GET', '/gallium/purchase?namespace=fn&offers=abc&analyticsSessionId=x');
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /window\.ue/);
  const s14 = await login(g.base, 'store3b@atlas.dev', 'pw', UA.v14_60);
  const list = (await call(g.base, 'GET', '/fortnite/api/cloudstorage/system', { token: s14.token, ua: UA.v14_60 })).json;
  assert.ok(!list.some((f) => f.filename === 'DefaultGame.ini'));
});

test('checkout: session finds the store visitor, completing grants V-Bucks and a receipt', async () => {
  const s = await login(g.base, 'buyer1@atlas.dev', 'Rebooted', UA.cert);
  const before = await balance(s);
  const pack = currency(await catalog(s))[1]; // 2,800 pack
  const epicId = pack.appStoreId[1];
  const session = (await call(g.base, 'GET', `/gallium/purchase/api/session?offers=${epicId}`)).json;
  assert.equal(session.pack.vbucks, 2800);
  assert.equal(session.pack.price, '$24.99');
  assert.equal(session.accounts[0].id, s.accountId, 'most recent store user from this address');

  const done = await call(g.base, 'POST', '/gallium/purchase/api/complete', { body: { offerId: epicId, accountId: s.accountId } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.balance, before + 2800);
  assert.equal(done.json.receipt.transactionState, 'Purchased');
  assert.equal(done.json.receipt.offers[0].offerId, epicId);
  assert.equal(done.json.receipt.offers[0].offerNamespace, 'fn');
  assert.equal(await balance(s), before + 2800, 'profile0 balance (what 1.8 shows) updated');

  // The client then verifies the receipt; Gallium recognises it and does not grant twice.
  const v = await mcp(g.base, s, 'VerifyRealMoneyPurchase', 'profile0', { appStore: 'EpicPurchasingService', receiptId: done.json.transactionId, receiptInfo: done.json.transactionId }, { ua: UA.cert });
  assert.equal(v.status, 200, v.text);
  assert.equal(profileOf(v).items['Currency:MtxPurchased'].quantity, before + 2800);
  const core = g.services.profiles.load(s.accountId, 'common_core', g.services.versions.resolve(UA.cert));
  assert.ok(core.stat('in_app_purchases').receipts.includes(`EPIC:${done.json.transactionId}`));
});

test('checkout rejects unknown packs, accounts that never visited the store, and disabled stores', async () => {
  const s = await login(g.base, 'buyer2@atlas.dev', 'Rebooted', UA.cert);
  const stranger = await login(g.base, 'stranger@atlas.dev', 'Rebooted', UA.v14_60);
  const epicId = currency(await catalog(s))[0].appStoreId[1];
  assert.equal((await call(g.base, 'POST', '/gallium/purchase/api/complete', { body: { offerId: 'nope', accountId: s.accountId } })).status, 400);
  assert.equal((await call(g.base, 'POST', '/gallium/purchase/api/complete', { body: { offerId: epicId, accountId: stranger.accountId } })).status, 403);
  assert.equal((await call(g.base, 'POST', '/gallium/purchase/api/complete', { body: {} })).status, 400);
  g.services.config.store.fakeVbucksPurchases = false;
  try {
    assert.equal((await call(g.base, 'POST', '/gallium/purchase/api/complete', { body: { offerId: epicId, accountId: s.accountId } })).status, 403);
  } finally {
    g.services.config.store.fakeVbucksPurchases = true;
  }
});

test('a purchase-flow token cookie identifies the buyer without a prior store visit', async () => {
  const s = await login(g.base, 'cookie@atlas.dev', 'Rebooted', UA.cert);
  const epicId = g.services.vbucksStore.packs()[0].epicOfferId;
  const session = (await call(g.base, 'GET', `/gallium/purchase/api/session?offers=${epicId}`, { headers: { Cookie: `EPIC_BEARER_TOKEN=${s.token}` } })).json;
  assert.equal(session.accounts[0].id, s.accountId);
  const r = await call(g.base, 'POST', '/gallium/purchase/api/complete', { headers: { Cookie: `EPIC_BEARER_TOKEN=${s.token}` }, body: { offerId: epicId, accountId: s.accountId } });
  assert.equal(r.status, 200);
});
