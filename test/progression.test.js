import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGallium, makeDataDir, login, mcp, profileOf, call, UA } from './helpers.js';
import { COSMETICS, QUESTS, BATTLE_PASS_S14 } from './fixtures.js';

let g;
before(async () => {
  g = await startGallium({ dataDir: makeDataDir({ 'cosmetics.json': COSMETICS, 'quests/default.json': QUESTS, 'battlepass/season14.json': BATTLE_PASS_S14 }) });
});
after(async () => {
  await g.stop();
});

const athenaOf = async (s, ua = UA.v14_60) => profileOf(await mcp(g.base, s, 'QueryProfile', 'athena', {}, { ua }));

test('Chapter 2+ rules: 80k XP per level and battle pass tiers follow level', async () => {
  const s = await login(g.base, 'xp14@test.dev');
  await athenaOf(s);
  const r = g.services.admin.addXp(s.accountId, 80000 * 2 + 500, '14.60');
  assert.equal(r.level, 3);
  assert.equal(r.xp, 500);
  assert.equal(r.tier, 3);
  const a = await athenaOf(s);
  assert.equal(a.stats.attributes.accountLevel, 3);
  assert.ok(a.items['AthenaItemWrap:Wrap_001_Camo'], 'free tier 2 reward');
  assert.equal(a.items['AthenaBackpack:BID_004_BlackKnight'], undefined, 'paid reward needs the battle pass');
});

test('Chapter 1 rules: battle stars buy tiers (10 stars per tier)', async () => {
  const s = await login(g.base, 'xp45@test.dev', 'pw', UA.v4_5);
  await athenaOf(s, UA.v4_5);
  const r = g.services.admin.addXp(s.accountId, 80000 * 5, '4.5'); // levels 2..6: 5+5+5+10+5 = 30 stars
  assert.equal(r.level, 6);
  const a = await athenaOf(s, UA.v4_5);
  assert.equal(a.stats.attributes.book_level, 4);
  assert.equal(a.stats.attributes.book_xp, 0);
});

test('daily and weekly quests: login grants, client objectives progress and complete', async () => {
  const s = await login(g.base, 'quests@test.dev');
  await athenaOf(s);
  let r = await mcp(g.base, s, 'ClientQuestLogin', 'athena');
  assert.equal(r.status, 200);
  let a = await athenaOf(s);
  const quests = Object.entries(a.items).filter(([, i]) => i.templateId.startsWith('Quest:'));
  assert.equal(quests.filter(([, i]) => i.attributes.gallium_kind === 'daily').length, 2, 'maxDaily');
  assert.equal(quests.filter(([, i]) => i.attributes.gallium_kind === 'weekly').length, 1);
  const before = quests.length;
  await mcp(g.base, s, 'ClientQuestLogin', 'athena');
  assert.equal(Object.values((await athenaOf(s)).items).filter((i) => i.templateId.startsWith('Quest:')).length, before, 'no duplicates on the same day');

  // reroll one daily
  const daily = quests.find(([, i]) => i.attributes.gallium_kind === 'daily');
  r = await mcp(g.base, s, 'FortRerollDailyQuest', 'athena', { questId: daily[0] });
  assert.equal(r.status, 200, r.text);
  a = await athenaOf(s);
  assert.equal(a.items[daily[0]], undefined);
  assert.equal(a.stats.attributes.quest_manager.dailyQuestRerolls, 0);
  assert.equal((await mcp(g.base, s, 'FortRerollDailyQuest', 'athena', { questId: Object.keys(a.items).find((id) => a.items[id].attributes.gallium_kind === 'daily') })).status, 400, 'no rerolls left');

  // the weekly completes from a client objective update and grants its item reward
  r = await mcp(g.base, s, 'UpdateQuestClientObjectives', 'athena', { advance: [{ statName: 'athena_weekly_test_win', count: 1, timestampOffset: 0 }] });
  assert.equal(r.status, 200);
  a = await athenaOf(s);
  const weekly = Object.values(a.items).find((i) => i.templateId === 'Quest:AthenaWeekly_Test_Win');
  assert.equal(weekly.attributes.quest_state, 'Claimed');
  assert.equal(weekly.attributes.completion_athena_weekly_test_win, 1);
  assert.ok(a.items['AthenaDance:EID_Floss']);
  assert.equal((await mcp(g.base, s, 'UpdateQuestClientObjectives', 'athena', { advance: [{ statName: 1 }] })).status, 400);
});

test('game-server match results update stats, XP, wins and quest progress', async () => {
  const s = await login(g.base, 'match@test.dev');
  await athenaOf(s);
  await mcp(g.base, s, 'ClientQuestLogin', 'athena');
  const server = (await call(g.base, 'POST', '/gallium/api/gameservers', { body: { address: '127.0.0.1', port: 7777, playlists: ['playlist_defaultsolo'] } })).json;
  const before = await athenaOf(s);
  const elimQuest = Object.values(before.items).find((i) => i.templateId === 'Quest:AthenaDaily_Test_Elims');
  const res = await call(g.base, 'POST', `/gallium/api/gameservers/${server.id}/results`, {
    body: { players: [{ accountId: s.accountId, placement: 1, kills: 3, score: 250, minutesPlayed: 18, xp: 1200, questProgress: { athena_daily_test_elims: 3 } }] },
  });
  assert.equal(res.status, 200, res.text);
  const a = await athenaOf(s);
  assert.equal(a.stats.attributes.lifetime_wins, 1);
  assert.equal(a.stats.attributes.season.numWins, 1);
  if (elimQuest) {
    // quest reward (90k XP) + match XP (1200) => level 2
    assert.equal(res.json.results[0].completedQuests[0], 'Quest:AthenaDaily_Test_Elims');
    assert.equal(a.stats.attributes.level, 2);
  } else {
    assert.equal(a.stats.attributes.xp, 1200);
  }
  const stats = (await call(g.base, 'GET', `/fortnite/api/statsv2/account/${s.accountId}`, { token: s.token })).json.stats;
  assert.equal(stats.br_kills_keyboardmouse_m0_playlist_defaultsolo, 3);
  assert.equal(stats.br_placetop1_keyboardmouse_m0_playlist_defaultsolo, 1);
  assert.equal(stats.br_matchesplayed_keyboardmouse_m0_playlist_defaultsolo, 1);
  const legacy = (await call(g.base, 'GET', `/fortnite/api/stats/accountId/${s.accountId}/bulk/window/alltime`, { token: s.token })).json;
  assert.ok(legacy.some((x) => x.name === 'br_kills_pc_m0_p2' && x.value === 3));
  assert.equal((await call(g.base, 'POST', `/gallium/api/gameservers/${server.id}/results`, { body: { players: [] } })).status, 400);
  assert.equal((await call(g.base, 'POST', `/gallium/api/gameservers/${server.id}/results`, { body: { players: [{ accountId: s.accountId, kills: -1 }] } })).status, 400);
});

test('admin API: create account, grant/revoke items, V-Bucks, exchange code', async () => {
  const created = await call(g.base, 'POST', '/gallium/api/admin/accounts', { body: { displayName: 'AdminMade', password: 'pw' } });
  assert.equal(created.status, 201);
  const dup = await call(g.base, 'POST', '/gallium/api/admin/accounts', { body: { displayName: 'AdminMade', password: 'pw' } });
  assert.equal(dup.status, 409);
  const grant = await call(g.base, 'POST', '/gallium/api/admin/accounts/AdminMade/items', { body: { templateIds: ['AthenaCharacter:CID_028_Athena_Commando_F'] } });
  assert.deepEqual(grant.json.granted, ['AthenaCharacter:CID_028_Athena_Commando_F']);
  const all = await call(g.base, 'POST', '/gallium/api/admin/accounts/AdminMade/items', { body: { templateIds: 'all' } });
  assert.equal(all.json.granted, COSMETICS.items.length - 1 + COSMETICS.banners.length + COSMETICS.bannerColors.length);
  const revoke = await call(g.base, 'DELETE', '/gallium/api/admin/accounts/AdminMade/items', { body: { templateIds: ['AthenaCharacter:CID_028_Athena_Commando_F'] } });
  assert.deepEqual(revoke.json.removed, ['AthenaCharacter:CID_028_Athena_Commando_F']);
  assert.equal((await call(g.base, 'POST', '/gallium/api/admin/accounts/AdminMade/vbucks', { body: { amount: 250, add: true } })).json.vbucks, 1250);
  assert.equal((await call(g.base, 'POST', '/gallium/api/admin/accounts/AdminMade/vbucks', { body: { amount: -5 } })).status, 400);
  const ex = await call(g.base, 'POST', '/gallium/api/admin/accounts/AdminMade/exchange');
  const tok = await call(g.base, 'POST', '/account/api/oauth/token', { form: { grant_type: 'exchange_code', exchange_code: ex.json.code } });
  assert.equal(tok.json.displayName, 'AdminMade');
  const desc = await call(g.base, 'GET', '/gallium/api/admin/accounts/AdminMade');
  assert.equal(desc.json.vbucks, 1250);
  assert.equal((await call(g.base, 'GET', '/gallium/api/admin/accounts/NoSuchUser')).status, 404);
});
