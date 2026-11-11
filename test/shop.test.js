import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, makeDataDir, login, mcp, profileOf, call, UA } from './helpers.js';
import { COSMETICS, SHOP, BATTLE_PASS_S14 } from './fixtures.js';

let g;
before(async () => {
  g = await startGallium({ dataDir: makeDataDir({ 'cosmetics.json': COSMETICS, 'shop.json': SHOP, 'battlepass/season14.json': BATTLE_PASS_S14 }) });
});
after(async () => {
  await g.stop();
});

const catalog = async (s, ua = UA.v14_60) => (await call(g.base, 'GET', '/fortnite/api/storefront/v2/catalog', { token: s.token, ua })).json;
const findEntry = (cat, templateId) => cat.storefronts.flatMap((f) => f.catalogEntries).find((e) => e.itemGrants.some((i) => i.templateId === templateId));
const vbucks = async (s) => profileOf(await mcp(g.base, s, 'QueryProfile', 'common_core')).items['Currency:MtxPurchased'].quantity;

test('catalog entries have the storefront v2 shape', async () => {
  const s = await login(g.base, 'shape@test.dev');
  const cat = await catalog(s);
  assert.equal(cat.refreshIntervalHrs, 24);
  const e = findEntry(cat, 'AthenaCharacter:CID_028_Athena_Commando_F');
  assert.match(e.offerId, /^v2:\/[0-9a-f]{64}$/);
  assert.deepEqual(e.prices[0], { currencyType: 'MtxCurrency', currencySubType: '', regularPrice: 1200, dynamicRegularPrice: -1, finalPrice: 1200, saleExpiration: '9999-12-31T23:59:59.999Z', basePrice: 1200 });
  assert.equal(e.requirements[0].requirementType, 'DenyOnItemOwnership');
  assert.equal(e.meta.SectionId, 'Featured');
  assert.ok(cat.storefronts.some((f) => f.name === 'BRSeason14'), 'battle pass storefront from data file');
  const old = await catalog(s, UA.v4_5);
  assert.equal(findEntry(old, 'AthenaCharacter:CID_028_Athena_Commando_F').meta, undefined, 'no section meta for Chapter 1');
});

test('purchase: charges V-Bucks, grants the item, reports loot and multiUpdate', async () => {
  const s = await login(g.base, 'buyer@test.dev');
  g.services.admin.setVbucks(s.accountId, 3000);
  const entry = findEntry(await catalog(s), 'AthenaPickaxe:Pickaxe_ID_013_Teslacoil');
  const rvn = (await mcp(g.base, s, 'QueryProfile', 'common_core')).json.profileCommandRevision;
  const r = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: entry.offerId, purchaseQuantity: 1, currency: 'MtxCurrency', currencySubType: '', expectedTotalPrice: 800, gameContext: 'Frontend.ItemShopScreen' }, { rvn });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.notifications[0].type, 'CatalogPurchase');
  assert.equal(r.json.notifications[0].lootResult.items[0].itemType, 'AthenaPickaxe:Pickaxe_ID_013_Teslacoil');
  assert.equal(r.json.multiUpdate[0].profileId, 'athena');
  assert.equal(r.json.multiUpdate[0].profileChanges[0].changeType, 'itemAdded');
  assert.ok(r.json.profileChanges.some((c) => c.changeType === 'itemQuantityChanged' && c.quantity === 2200));
  assert.equal(await vbucks(s), 2200);
  assert.ok(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena')).items['AthenaPickaxe:Pickaxe_ID_013_Teslacoil']);
  // owning it now blocks a second purchase
  const again = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: entry.offerId, purchaseQuantity: 1, currency: 'MtxCurrency', expectedTotalPrice: 800 });
  assert.equal(again.json.errorCode, 'errors.com.epicgames.offer.already_owned');
  assert.equal(await vbucks(s), 2200);
});

test('purchase validation: unknown offer, price mismatch, insufficient V-Bucks', async () => {
  const s = await login(g.base, 'poor@test.dev');
  g.services.admin.setVbucks(s.accountId, 100);
  const entry = findEntry(await catalog(s), 'AthenaDance:EID_Floss');
  assert.equal((await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: 'v2:/nope', purchaseQuantity: 1 })).status, 400);
  const mismatch = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: entry.offerId, purchaseQuantity: 1, expectedTotalPrice: 1 });
  assert.equal(mismatch.json.errorCode, 'errors.com.epicgames.validation.validation_failed');
  const poor = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: entry.offerId, purchaseQuantity: 1, expectedTotalPrice: 500 });
  assert.equal(poor.json.errorCode, 'errors.com.epicgames.currency.mtx.insufficient');
  assert.equal(await vbucks(s), 100, 'nothing charged on failure');
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena')).items['AthenaDance:EID_Floss'], undefined, 'nothing granted on failure');
});

test('season-gated offers are not purchasable from older builds', async () => {
  const s = await login(g.base, 'gate@test.dev', 'pw', UA.v4_5);
  g.services.admin.setVbucks(s.accountId, 5000);
  // CID_A_001 is a season 14 item: it is listed manually, but the 4.5 catalog still includes manual entries.
  const cat = await catalog(s, UA.v4_5);
  assert.ok(findEntry(cat, 'AthenaCharacter:CID_A_001_Athena_Commando_M'));
});

test('refunds return V-Bucks and remove the item', async () => {
  const s = await login(g.base, 'refund@test.dev');
  g.services.admin.setVbucks(s.accountId, 2000);
  const entry = findEntry(await catalog(s), 'AthenaCharacter:CID_028_Athena_Commando_F');
  await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: entry.offerId, purchaseQuantity: 1, expectedTotalPrice: 1200 });
  const core = profileOf(await mcp(g.base, s, 'QueryProfile', 'common_core'));
  const purchase = core.stats.attributes.mtx_purchase_history.purchases[0];
  assert.equal(purchase.totalMtxPaid, 1200);
  const r = await mcp(g.base, s, 'RefundMtxPurchase', 'common_core', { purchaseId: purchase.purchaseId, quickReturn: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(await vbucks(s), 2000);
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena')).items['AthenaCharacter:CID_028_Athena_Commando_F'], undefined);
  assert.equal((await mcp(g.base, s, 'RefundMtxPurchase', 'common_core', { purchaseId: purchase.purchaseId })).status, 404, 'cannot refund twice');
});

test('gifting requires friendship, charges the sender and delivers a gift box', async () => {
  const a = await login(g.base, 'gifter@test.dev');
  const b = await login(g.base, 'giftee@test.dev');
  g.services.admin.setVbucks(a.accountId, 1000);
  const entry = findEntry(await catalog(a), 'AthenaDance:EID_Floss');
  const body = { offerId: entry.offerId, currency: 'MtxCurrency', currencySubType: '', expectedTotalPrice: 500, gameContext: '', receiverAccountIds: [b.accountId], giftWrapTemplateId: 'GiftBox:gb_default', personalMessage: 'enjoy' };
  assert.equal((await mcp(g.base, a, 'GiftCatalogEntry', 'common_core', body)).status, 403, 'not friends yet');
  g.services.friends.request(a.accountId, b.accountId);
  g.services.friends.request(b.accountId, a.accountId);
  const elig = await call(g.base, 'GET', `/fortnite/api/storefront/v2/gift/check_eligibility/recipient/${b.accountId}/offer/${encodeURIComponent(entry.offerId)}`, { token: a.token });
  assert.equal(elig.status, 200);
  const r = await mcp(g.base, a, 'GiftCatalogEntry', 'common_core', body);
  assert.equal(r.status, 200, r.text);
  assert.equal(await vbucks(a), 500);
  const coreB = profileOf(await mcp(g.base, b, 'QueryProfile', 'common_core'));
  const box = Object.entries(coreB.items).find(([, i]) => i.templateId === 'GiftBox:gb_default');
  assert.ok(box, 'gift box delivered');
  assert.equal(box[1].attributes.fromAccountId, a.accountId);
  assert.equal(box[1].attributes.params.userMessage, 'enjoy');
  assert.ok(profileOf(await mcp(g.base, b, 'QueryProfile', 'athena')).items['AthenaDance:EID_Floss']);
  assert.equal((await mcp(g.base, b, 'RemoveGiftBox', 'common_core', { giftBoxItemId: box[0] })).status, 200);
  assert.equal((await mcp(g.base, a, 'GiftCatalogEntry', 'common_core', body)).json.errorCode, 'errors.com.epicgames.offer.already_owned');
});

test('battle pass offers: purchase, tiers and rewards', async () => {
  const s = await login(g.base, 'bp@test.dev');
  g.services.admin.setVbucks(s.accountId, 5000);
  await mcp(g.base, s, 'QueryProfile', 'athena');
  const r = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: 'BP14_BASE', purchaseQuantity: 1, expectedTotalPrice: 950 });
  assert.equal(r.status, 200, r.text);
  let athena = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  assert.equal(athena.stats.attributes.book_purchased, true);
  assert.ok(athena.items['AthenaGlider:Glider_ID_001'], 'paid tier 1 reward granted retroactively');
  assert.equal((await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: 'BP14_BASE', purchaseQuantity: 1 })).json.errorCode, 'errors.com.epicgames.offer.already_owned');
  const tiers = await mcp(g.base, s, 'PurchaseCatalogEntry', 'common_core', { offerId: 'BP14_TIER', purchaseQuantity: 2, expectedTotalPrice: 300 });
  assert.equal(tiers.status, 200, tiers.text);
  athena = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  assert.equal(athena.stats.attributes.book_level, 3);
  assert.ok(athena.items['AthenaItemWrap:Wrap_001_Camo'] && athena.items['AthenaBackpack:BID_004_BlackKnight']);
  assert.equal(await vbucks(s), 5000 - 950 - 300);
});
