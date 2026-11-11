import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, makeDataDir, login, mcp, profileOf, call, UA } from './helpers.js';
import { COSMETICS } from './fixtures.js';

let g;
before(async () => {
  g = await startGallium({ dataDir: makeDataDir({ 'cosmetics.json': COSMETICS }) });
});
after(async () => {
  await g.stop();
});

async function freshAthena(name, ua = UA.v14_60) {
  const s = await login(g.base, `${name}@test.dev`, 'pw', ua);
  const q = await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua });
  return { s, rvn: q.json.profileCommandRevision, profile: profileOf(q) };
}

test('MCP: incremental changes when rvn matches, full profile when stale', async () => {
  const { s, rvn } = await freshAthena('rvn');
  const delta = await mcp(g.base, s, 'MarkItemSeen', 'athena', { itemIds: ['AthenaPickaxe:DefaultPickaxe'] }, { rvn });
  assert.equal(delta.json.profileChangesBaseRevision, rvn);
  assert.equal(delta.json.profileRevision, rvn + 1);
  assert.deepEqual(delta.json.profileChanges, [{ changeType: 'itemAttrChanged', itemId: 'AthenaPickaxe:DefaultPickaxe', attributeName: 'item_seen', attributeValue: true }]);
  const stale = await mcp(g.base, s, 'SetItemFavoriteStatus', 'athena', { targetItemId: 'AthenaPickaxe:DefaultPickaxe', bFavorite: true }, { rvn: rvn - 1 });
  assert.equal(stale.json.profileChanges[0].changeType, 'fullProfileUpdate');
  assert.equal(profileOf(stale).items['AthenaPickaxe:DefaultPickaxe'].attributes.favorite, true);
  const noop = await mcp(g.base, s, 'MarkItemSeen', 'athena', { itemIds: ['AthenaPickaxe:DefaultPickaxe'] }, { rvn: stale.json.profileCommandRevision });
  assert.equal(noop.json.profileRevision, stale.json.profileRevision, 'no change, no revision bump');
});

test('MCP: errors for unknown commands, profiles, items and other accounts', async () => {
  const { s } = await freshAthena('errs');
  const other = await login(g.base, 'errs2@test.dev', 'pw');
  const unknownOp = await mcp(g.base, s, 'DoTheThing', 'athena');
  assert.equal(unknownOp.status, 404);
  assert.equal(unknownOp.json.errorCode, 'errors.com.epicgames.fortnite.operation_not_found');
  assert.equal((await mcp(g.base, s, 'QueryProfile', 'not_a_profile')).status, 403);
  const missing = await mcp(g.base, s, 'SetItemFavoriteStatus', 'athena', { targetItemId: 'AthenaCharacter:CID_Nope', bFavorite: true });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.errorCode, 'errors.com.epicgames.fortnite.item_not_found');
  assert.equal((await mcp(g.base, s, 'SetItemFavoriteStatus', 'athena', { targetItemId: 1 })).status, 400);
  const foreign = await mcp(g.base, s, 'QueryProfile', 'athena', {}, { accountId: other.accountId });
  assert.equal(foreign.status, 403);
  const wrongProfile = await mcp(g.base, s, 'PurchaseCatalogEntry', 'athena', { offerId: 'x' });
  assert.equal(wrongProfile.status, 400);
});

test('EquipBattleRoyaleCustomization (4.5): favorites, dance slots, wraps, variants', async () => {
  const { s } = await freshAthena('equip45', UA.v4_5);
  g.services.admin.grantItems(s.accountId, ['AthenaCharacter:CID_175_Athena_Commando_M_Celestial', 'AthenaDance:EID_Floss', 'AthenaItemWrap:Wrap_001_Camo']);
  const opts = { ua: UA.v4_5 };
  let r = await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Character', itemToSlot: 'AthenaCharacter:CID_175_Athena_Commando_M_Celestial', indexWithinSlot: 0, variantUpdates: [{ channel: 'Material', active: 'Mat2' }] }, opts);
  assert.equal(r.status, 200, r.text);
  r = await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Dance', itemToSlot: 'AthenaDance:EID_Floss', indexWithinSlot: 3 }, opts);
  r = await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'ItemWrap', itemToSlot: 'AthenaItemWrap:Wrap_001_Camo', indexWithinSlot: -1 }, opts);
  const p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, opts));
  assert.equal(p.stats.attributes.favorite_character, 'AthenaCharacter:CID_175_Athena_Commando_M_Celestial');
  assert.equal(p.stats.attributes.favorite_dance[3], 'AthenaDance:EID_Floss');
  assert.ok(p.stats.attributes.favorite_itemwraps.every((w) => w === 'AthenaItemWrap:Wrap_001_Camo'));
  assert.equal(p.items['AthenaCharacter:CID_175_Athena_Commando_M_Celestial'].attributes.variants.find((v) => v.channel === 'Material').active, 'Mat2');
  assert.equal(Object.values(p.items).some((i) => i.templateId.startsWith('CosmeticLocker')), false, 'no locker item on 4.5');
  // invalid inputs
  assert.equal((await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Hat', itemToSlot: '' }, opts)).status, 400);
  assert.equal((await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Character', itemToSlot: 'AthenaCharacter:CID_028_Athena_Commando_F' }, opts)).status, 404, 'not owned');
  assert.equal((await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Pickaxe', itemToSlot: 'AthenaDance:EID_Floss' }, opts)).status, 400, 'wrong slot type');
  assert.equal((await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Dance', itemToSlot: 'AthenaDance:EID_Floss', indexWithinSlot: 9 }, opts)).status, 400);
  assert.equal((await mcp(g.base, s, 'EquipBattleRoyaleCustomization', 'athena', { slotName: 'Character', itemToSlot: 'AthenaCharacter:CID_175_Athena_Commando_M_Celestial', variantUpdates: [{ channel: 'Material', active: 'Mat9' }] }, opts)).status, 400, 'unowned variant');
});

test('SetCosmeticLockerSlot (14.60): locker item, favorites mirror, banners, presets', async () => {
  const { s } = await freshAthena('locker14');
  g.services.admin.grantItems(s.accountId, ['AthenaCharacter:CID_A_001_Athena_Commando_M', 'AthenaBackpack:BID_004_BlackKnight']);
  let r = await mcp(g.base, s, 'SetCosmeticLockerSlot', 'athena', { lockerItem: 'sandbox_loadout', category: 'Character', itemToSlot: 'AthenaCharacter:CID_A_001_Athena_Commando_M', slotIndex: 0, variantUpdates: [], optLockerUseCountOverride: -1 });
  assert.equal(r.status, 200, r.text);
  r = await mcp(g.base, s, 'SetCosmeticLockerSlot', 'athena', { lockerItem: 'sandbox_loadout', category: 'Backpack', itemToSlot: 'AthenaBackpack:BID_004_BlackKnight', slotIndex: 0, variantUpdates: [] });
  r = await mcp(g.base, s, 'SetCosmeticLockerBanner', 'athena', { lockerItem: 'sandbox_loadout', bannerIconTemplateName: 'BRSeason01', bannerColorTemplateName: 'DefaultColor1' });
  assert.equal(r.status, 200);
  let p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  const locker = p.items.sandbox_loadout.attributes;
  assert.equal(locker.locker_slots_data.slots.Character.items[0], 'AthenaCharacter:CID_A_001_Athena_Commando_M');
  assert.equal(locker.locker_slots_data.slots.Backpack.items[0], 'AthenaBackpack:BID_004_BlackKnight');
  assert.equal(locker.banner_icon_template, 'BRSeason01');
  assert.equal(p.stats.attributes.favorite_character, 'AthenaCharacter:CID_A_001_Athena_Commando_M');
  assert.equal(p.stats.attributes.banner_icon, 'BRSeason01');
  // save the loadout as preset 1, change the active one, then apply preset 1 back
  r = await mcp(g.base, s, 'CopyCosmeticLoadout', 'athena', { sourceIndex: 0, targetIndex: 1, optNewNameForTarget: 'Sweaty' });
  assert.equal(r.status, 200, r.text);
  await mcp(g.base, s, 'SetCosmeticLockerSlot', 'athena', { lockerItem: 'sandbox_loadout', category: 'Character', itemToSlot: '', slotIndex: 0 });
  p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  assert.equal(p.stats.attributes.favorite_character, '');
  assert.equal(p.stats.attributes.loadouts.length, 2);
  assert.equal(p.items[p.stats.attributes.loadouts[1]].attributes.locker_name, 'Sweaty');
  await mcp(g.base, s, 'CopyCosmeticLoadout', 'athena', { sourceIndex: 1, targetIndex: 0 });
  p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  assert.equal(p.stats.attributes.favorite_character, 'AthenaCharacter:CID_A_001_Athena_Commando_M');
  r = await mcp(g.base, s, 'DeleteCosmeticLoadout', 'athena', { index: 1, fallbackLoadoutIndex: 0, leaveNullSlot: false });
  assert.equal(r.status, 200);
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena')).stats.attributes.loadouts.length, 1);
  assert.equal((await mcp(g.base, s, 'SetCosmeticLockerSlot', 'athena', { lockerItem: 'nope', category: 'Character', itemToSlot: '' })).status, 404);
});

test('athena items are filtered to what the build can use', async () => {
  const s = await login(g.base, 'filter@test.dev', 'pw', UA.v4_5);
  g.services.admin.grantItems(s.accountId, ['AthenaCharacter:CID_028_Athena_Commando_F', 'AthenaCharacter:CID_A_001_Athena_Commando_M']);
  const old = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v4_5 }));
  assert.ok(old.items['AthenaCharacter:CID_028_Athena_Commando_F']);
  assert.equal(old.items['AthenaCharacter:CID_A_001_Athena_Commando_M'], undefined, 'season 14 item hidden from 4.5');
  const s14 = await login(g.base, 'filter@test.dev', 'pw', UA.v14_60);
  const now = profileOf(await mcp(g.base, s14, 'QueryProfile', 'athena'));
  assert.ok(now.items['AthenaCharacter:CID_A_001_Athena_Commando_M']);
});

test('switching builds keeps separate progression per season', async () => {
  const s = await login(g.base, 'seasons@test.dev', 'pw', UA.v4_5);
  await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v4_5 });
  g.services.admin.addXp(s.accountId, 200000, '4.5');
  let p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v4_5 }));
  const s4Level = p.stats.attributes.level;
  assert.ok(s4Level > 1);
  p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v14_60 }));
  assert.equal(p.stats.attributes.season_num, 14);
  assert.equal(p.stats.attributes.level, 1, 'fresh season 14 progression');
  assert.equal(p.stats.attributes.past_seasons[0].seasonNumber, 4);
  assert.equal(p.stats.attributes.past_seasons[0].seasonLevel, s4Level);
  p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v4_5 }));
  assert.equal(p.stats.attributes.level, s4Level, 'season 4 progress restored');
});

test('dedicated_server route reads another account; public route only allows public profiles', async () => {
  const player = await login(g.base, 'dsplayer@test.dev');
  const server = await login(g.base, 'dshost@test.dev');
  const r = await mcp(g.base, server, 'QueryProfile', 'athena', {}, { accountId: player.accountId, route: 'dedicated_server' });
  assert.equal(r.status, 200);
  assert.equal(profileOf(r).accountId, player.accountId);
  const cmd = await mcp(g.base, server, 'MarkItemSeen', 'athena', { itemIds: [] }, { accountId: player.accountId, route: 'dedicated_server' });
  assert.equal(cmd.status, 403, 'only QueryProfile on dedicated_server');
  const pub = await mcp(g.base, server, 'QueryPublicProfile', 'common_public', {}, { accountId: player.accountId, route: 'public' });
  assert.equal(pub.status, 200);
});

test('legacy builds read V-Bucks from profile0, mirrored from common_core', async () => {
  const s = await login(g.base, 'legacy@test.dev', 'pw', UA.v3_1);
  g.services.admin.setVbucks(s.accountId, 4321);
  const p0 = profileOf(await mcp(g.base, s, 'QueryProfile', 'profile0', {}, { ua: UA.v3_1 }));
  assert.equal(p0.items['Currency:MtxPurchased'].quantity, 4321);
  const s14 = await login(g.base, 'legacy@test.dev', 'pw');
  const core = profileOf(await mcp(g.base, s14, 'QueryProfile', 'common_core'));
  assert.equal(core.items['Currency:MtxPurchased'].quantity, 4321);
});

test('misc MCP commands: platform, gifts toggle, affiliate, MFA reward, counters, archive', async () => {
  const s = await login(g.base, 'misc@test.dev');
  assert.equal((await mcp(g.base, s, 'SetMtxPlatform', 'common_core', { newPlatform: 'EpicPC' })).status, 200);
  assert.equal((await mcp(g.base, s, 'SetMtxPlatform', 'common_core', { newPlatform: 'Atari' })).status, 400);
  await mcp(g.base, s, 'SetReceiveGiftsEnabled', 'common_core', { bReceiveGifts: false });
  await mcp(g.base, s, 'SetAffiliateName', 'common_core', { affiliateName: 'gallium' });
  const mfa = await mcp(g.base, s, 'ClaimMfaEnabled', 'common_core', { bClaimForStw: false });
  assert.equal(mfa.json.multiUpdate[0].profileId, 'athena');
  assert.equal(mfa.json.multiUpdate[0].profileChanges[0].item.templateId, 'AthenaDance:EID_BoogieDown');
  const core = profileOf(await mcp(g.base, s, 'QueryProfile', 'common_core'));
  assert.equal(core.stats.attributes.allowed_to_receive_gifts, false);
  assert.equal(core.stats.attributes.mtx_affiliate, 'gallium');
  const coreRvn = (await mcp(g.base, s, 'QueryProfile', 'common_core')).json.profileCommandRevision;
  const again = await mcp(g.base, s, 'ClaimMfaEnabled', 'common_core', {}, { rvn: coreRvn });
  assert.equal(again.json.profileChanges.length, 0, 'reward only once');
  assert.equal(again.json.multiUpdate, undefined);
  await mcp(g.base, s, 'SetItemArchivedStatusBatch', 'athena', { itemIds: ['AthenaGlider:DefaultGlider'], archived: true });
  await mcp(g.base, s, 'SetItemFavoriteStatusBatch', 'athena', { itemIds: ['AthenaGlider:DefaultGlider'], itemFavStatus: [true] });
  const athena = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena'));
  assert.equal(athena.items['AthenaGlider:DefaultGlider'].attributes.archived, true);
  assert.equal(athena.items['AthenaGlider:DefaultGlider'].attributes.favorite, true);
  const cert = await login(g.base, 'misc@test.dev', 'Rebooted', UA.cert);
  await mcp(g.base, cert, 'IncrementNamedCounterStat', 'profile0', { counterName: 'Logins' }, { ua: UA.cert });
  const p0 = profileOf(await mcp(g.base, cert, 'IncrementNamedCounterStat', 'profile0', { counterName: 'Logins' }, { ua: UA.cert }));
  assert.equal(p0.stats.attributes.named_counters.Logins.current_count, 2);
});

test('a command that fails halfway is rolled back completely (DB and cache)', async () => {
  const { s } = await freshAthena('rollback', UA.v4_5);
  const opts = { ua: UA.v4_5 };
  const r = await mcp(g.base, s, 'BulkEquipBattleRoyaleCustomization', 'athena', {
    loadoutData: [
      { slotName: 'Dance', itemToSlot: 'AthenaDance:EID_DanceMoves', indexWithinSlot: 5 },
      { slotName: 'Character', itemToSlot: 'AthenaCharacter:NotOwned', indexWithinSlot: 0 },
    ],
  }, opts);
  assert.equal(r.status, 404);
  const p = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, opts));
  assert.equal(p.stats.attributes.favorite_dance[5], '', 'first entry was not committed');
});

test('writes from another process (the CLI) are visible to the running server', async () => {
  const { s } = await freshAthena('external');
  await mcp(g.base, s, 'QueryProfile', 'common_core'); // warm the cache
  const { createApp } = await import('../src/app.js');
  const { createLogger } = await import('../src/core/logger.js');
  const other = createApp({ config: g.services.config, log: createLogger({ level: 'silent' }) });
  other.services.admin.setVbucks(s.accountId, 777);
  other.close();
  const core = profileOf(await mcp(g.base, s, 'QueryProfile', 'common_core'));
  assert.equal(core.items['Currency:MtxPurchased'].quantity, 777);
});

test('requests without a Fortnite User-Agent use the account\'s last build, not the fallback', async () => {
  const s = await login(g.base, 'noua@test.dev', 'pw', UA.v21_50);
  await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v21_50 });
  const viaTool = profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: 'curl/8.4.0' }));
  assert.equal(viaTool.stats.attributes.season_num, 21);
  await call(g.base, 'GET', `/fortnite/api/game/v2/privacy/account/${s.accountId}`, { token: s.token, ua: 'curl/8.4.0' });
  assert.equal(profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua: UA.v21_50 })).stats.attributes.past_seasons.length, 0, 'season never switched');
});

test('privacy settings persist', async () => {
  const s = await login(g.base, 'privacy@test.dev');
  const set = await call(g.base, 'POST', `/fortnite/api/game/v2/privacy/account/${s.accountId}`, { token: s.token, body: { optOutOfPublicLeaderboards: true } });
  assert.equal(set.json.optOutOfPublicLeaderboards, true);
  const get = await call(g.base, 'GET', `/fortnite/api/game/v2/privacy/account/${s.accountId}`, { token: s.token });
  assert.equal(get.json.optOutOfPublicLeaderboards, true);
});
