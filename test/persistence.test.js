import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, makeDataDir, login, mcp, profileOf, call, UA } from './helpers.js';
import { COSMETICS, SHOP } from './fixtures.js';

test('accounts, tokens, profiles, lockers, purchases, cloud files and friends survive a restart', async () => {
  const dataDir = makeDataDir({ 'cosmetics.json': COSMETICS, 'shop.json': SHOP });
  let g = await startGallium({ dataDir });
  const a = await login(g.base, 'persist@test.dev', 'hunter2');
  const b = await login(g.base, 'persist2@test.dev', 'pw');
  g.services.admin.setVbucks(a.accountId, 5000);

  // purchase + equip + locker change + cloud file + friendship + stats
  const cat = (await call(g.base, 'GET', '/fortnite/api/storefront/v2/catalog', { token: a.token })).json;
  const offer = cat.storefronts.flatMap((f) => f.catalogEntries).find((e) => e.itemGrants[0].templateId === 'AthenaCharacter:CID_028_Athena_Commando_F');
  assert.equal((await mcp(g.base, a, 'PurchaseCatalogEntry', 'common_core', { offerId: offer.offerId, purchaseQuantity: 1, expectedTotalPrice: 1200 })).status, 200);
  assert.equal((await mcp(g.base, a, 'SetCosmeticLockerSlot', 'athena', { lockerItem: 'sandbox_loadout', category: 'Character', itemToSlot: 'AthenaCharacter:CID_028_Athena_Commando_F', slotIndex: 0 })).status, 200);
  await mcp(g.base, a, 'SetItemFavoriteStatus', 'athena', { targetItemId: 'AthenaCharacter:CID_028_Athena_Commando_F', bFavorite: true });
  await call(g.base, 'PUT', `/fortnite/api/cloudstorage/user/${a.accountId}/ClientSettings.Sav`, { token: a.token, raw: Buffer.from('settings-v1') });
  await call(g.base, 'POST', `/friends/api/v1/${a.accountId}/friends/${b.accountId}`, { token: a.token });
  await call(g.base, 'POST', `/friends/api/v1/${b.accountId}/friends/${a.accountId}`, { token: b.token });
  g.services.stats.recordMatch(a.accountId, { playlist: 'Playlist_DefaultSolo', placement: 1, kills: 4 });
  const before = profileOf(await mcp(g.base, a, 'QueryProfile', 'athena'));
  await g.stop();

  // ---- restart on the same database ----
  g = await startGallium({ dataDir });
  assert.equal((await call(g.base, 'GET', '/account/api/oauth/verify', { token: a.token })).status, 200, 'access token still valid');
  const relog = await login(g.base, 'persist@test.dev', 'hunter2');
  assert.equal(relog.accountId, a.accountId);
  assert.equal((await call(g.base, 'POST', '/account/api/oauth/token', { headers: { Authorization: 'basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6' }, form: { grant_type: 'password', username: 'persist@test.dev', password: 'wrong' } })).status, 400);

  const after = profileOf(await mcp(g.base, relog, 'QueryProfile', 'athena'));
  assert.equal(after.rvn, before.rvn, 'revision preserved');
  assert.equal(after.stats.attributes.favorite_character, 'AthenaCharacter:CID_028_Athena_Commando_F');
  assert.equal(after.items.sandbox_loadout.attributes.locker_slots_data.slots.Character.items[0], 'AthenaCharacter:CID_028_Athena_Commando_F');
  assert.equal(after.items['AthenaCharacter:CID_028_Athena_Commando_F'].attributes.favorite, true);
  const core = profileOf(await mcp(g.base, relog, 'QueryProfile', 'common_core'));
  assert.equal(core.items['Currency:MtxPurchased'].quantity, 3800);
  assert.equal(core.stats.attributes.mtx_purchase_history.purchases.length, 1);
  assert.equal((await call(g.base, 'GET', `/fortnite/api/cloudstorage/user/${a.accountId}/ClientSettings.Sav`, { token: relog.token })).text, 'settings-v1');
  const friends = (await call(g.base, 'GET', `/friends/api/v1/${a.accountId}/summary`, { token: relog.token })).json;
  assert.deepEqual(friends.friends.map((f) => f.accountId), [b.accountId]);
  const stats = (await call(g.base, 'GET', `/fortnite/api/statsv2/account/${a.accountId}`, { token: relog.token })).json.stats;
  assert.equal(stats.br_kills_keyboardmouse_m0_playlist_defaultsolo, 4);
  assert.equal(stats.br_placetop1_keyboardmouse_m0_playlist_defaultsolo, 1);
  await g.stop();
});

test('the schema migrates once and reopens cleanly', async () => {
  const dataDir = makeDataDir();
  let g = await startGallium({ dataDir });
  const version = g.services.db.schemaVersion;
  assert.ok(version >= 1);
  await g.stop();
  g = await startGallium({ dataDir });
  assert.equal(g.services.db.schemaVersion, version);
  await g.stop();
});

test('Chapter 5 Locker Service: default items, active group storage, presets, athena mirror', async () => {
  const g = await startGallium({ dataDir: makeDataDir({ 'cosmetics.json': COSMETICS }) });
  const s = await login(g.base, 'c5locker@test.dev', 'pw', UA.v32_00);
  g.services.admin.grantItems(s.accountId, ['AthenaCharacter:CID_A_001_Athena_Commando_M']);
  const base = `/api/locker/v4/62a9473a2dca46b29ccf17577fcf42d7/account/${s.accountId}`;
  const opts = { token: s.token, ua: UA.v32_00 };
  const initial = await call(g.base, 'GET', `${base}/items`, opts);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json.loadoutPresets, []);
  assert.deepEqual(initial.json.loadoutGroupPresets, []);
  assert.equal(initial.json.activeLoadoutGroup.accountId, s.accountId);
  assert.deepEqual(initial.json.activeLoadoutGroup.loadouts, {});
  const loadouts = {
    'CosmeticLoadout:LoadoutSchema_Character': {
      loadoutSlots: [
        { slotTemplate: 'CosmeticLoadoutSlotTemplate:LoadoutSlot_Character', equippedItemId: 'AthenaCharacter:CID_A_001_Athena_Commando_M', itemCustomizations: [] },
        { slotTemplate: 'CosmeticLoadoutSlotTemplate:LoadoutSlot_Pickaxe', equippedItemId: 'AthenaPickaxe:DefaultPickaxe', itemCustomizations: [] },
      ],
      shuffleType: 'DISABLED',
    },
  };
  const put = await call(g.base, 'PUT', `${base}/active-loadout-group`, { ...opts, body: { loadouts } });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.loadouts, loadouts);
  assert.equal((await call(g.base, 'PUT', `${base}/active-loadout-group`, { ...opts, body: { loadouts: { bad: {} } } })).status, 400);
  const preset = await call(g.base, 'PUT', `${base}/loadout-presets/CosmeticLoadout:LoadoutSchema_Character/0`, { ...opts, body: { displayName: 'Main', loadoutSlots: loadouts['CosmeticLoadout:LoadoutSchema_Character'].loadoutSlots } });
  assert.equal(preset.status, 200, preset.text);
  assert.equal(preset.json.presetIndex, 0);
  await g.stop();

  // persisted across restart, and mirrored into athena for dedicated-server readers
  const g2 = await startGallium({ dataDir: g.dataDir });
  const items = await call(g2.base, 'GET', `${base}/items`, opts);
  assert.deepEqual(items.json.activeLoadoutGroup.loadouts, loadouts);
  assert.equal(items.json.loadoutPresets[0].displayName, 'Main');
  const athena = profileOf(await mcp(g2.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v32_00, extraQuery: '&dataOmissionGroup=Locker' }));
  assert.equal(athena.stats.attributes.favorite_character, 'AthenaCharacter:CID_A_001_Athena_Commando_M');
  assert.equal((await call(g2.base, 'DELETE', `${base}/loadout-presets/CosmeticLoadout:LoadoutSchema_Character/0`, opts)).status, 204);
  await g2.stop();
});
