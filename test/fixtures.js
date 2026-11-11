/** Small cosmetics list in the data/cosmetics.json format used by several tests. */
export const COSMETICS = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  items: [
    { id: 'CID_028_Athena_Commando_F', type: 'AthenaCharacter', season: 1, rarity: 'legendary', variants: [] },
    { id: 'CID_175_Athena_Commando_M_Celestial', type: 'AthenaCharacter', season: 4, rarity: 'legendary', variants: [{ channel: 'Material', options: ['Mat1', 'Mat2'] }] },
    { id: 'CID_A_001_Athena_Commando_M', type: 'AthenaCharacter', season: 14, rarity: 'epic', variants: [] },
    { id: 'BID_004_BlackKnight', type: 'AthenaBackpack', season: 2, rarity: 'legendary', variants: [] },
    { id: 'Pickaxe_ID_013_Teslacoil', type: 'AthenaPickaxe', season: 3, rarity: 'epic', variants: [] },
    { id: 'Glider_ID_001', type: 'AthenaGlider', season: 1, rarity: 'uncommon', variants: [] },
    { id: 'EID_Floss', type: 'AthenaDance', season: 2, rarity: 'rare', variants: [] },
    { id: 'Wrap_001_Camo', type: 'AthenaItemWrap', season: 5, rarity: 'rare', variants: [] },
  ],
  banners: ['StandardBanner1', 'BRSeason01'],
  bannerColors: ['DefaultColor1'],
};

export const SHOP = {
  rotation: { enabled: false },
  featured: [{ items: ['AthenaCharacter:CID_028_Athena_Commando_F'], price: 1200 }],
  daily: [
    { items: ['AthenaPickaxe:Pickaxe_ID_013_Teslacoil'], price: 800 },
    { items: ['AthenaDance:EID_Floss'], price: 500 },
    { items: ['AthenaCharacter:CID_A_001_Athena_Commando_M'], price: 2000 },
  ],
};

export const BATTLE_PASS_S14 = {
  offers: {
    battlePass: { offerId: 'BP14_BASE', price: 950 },
    bundle: { offerId: 'BP14_BUNDLE', price: 2800, tiers: 25 },
    tier: { offerId: 'BP14_TIER', price: 150 },
  },
  tiers: {
    1: { free: [], paid: [{ templateId: 'AthenaGlider:Glider_ID_001' }] },
    2: { free: [{ templateId: 'AthenaItemWrap:Wrap_001_Camo' }], paid: [] },
    3: { free: [], paid: [{ templateId: 'AthenaBackpack:BID_004_BlackKnight' }] },
  },
};

export const QUESTS = {
  maxDaily: 2,
  daily: [
    { templateId: 'Quest:AthenaDaily_Test_Elims', objectives: [{ name: 'athena_daily_test_elims', count: 3 }], rewards: { xp: 90000 } },
    { templateId: 'Quest:AthenaDaily_Test_Chests', objectives: [{ name: 'athena_daily_test_chests', count: 2 }], rewards: { xp: 1000 } },
    { templateId: 'Quest:AthenaDaily_Test_Play', objectives: [{ name: 'athena_daily_test_play', count: 1 }], rewards: { xp: 500 } },
  ],
  weekly: [{ templateId: 'Quest:AthenaWeekly_Test_Win', objectives: [{ name: 'athena_weekly_test_win', count: 1 }], rewards: { items: [{ templateId: 'AthenaDance:EID_Floss' }] } }],
};
