/**
 * Shared defaults for every version adapter. An adapter is a plain object; defineAdapter()
 * merges it over this base, so a new adapter only declares what differs for its builds.
 *
 * Adapter surface (all optional except id/matches):
 *   id, description, matches(build)
 *   profileIds            profiles the client may query
 *   currencyProfile       profile holding V-Bucks (common_core; profile0 before 3.5)
 *   features              flags read by the shared services
 *   progression           XP/level/battle pass rules
 *   athenaStats(build)    default stats for a new athena profile
 *   timelineState(build)  calendar "client-events" state
 *   timelineEvents(build) active event flags
 *   contentPages(build, pages)  mutate/extend /content/api/pages/fortnite-game
 *   catalogEntry(entry, build)  final shaping of a storefront entry
 *   mcpCommands           extra or overriding MCP commands { Name: handler }
 *   registerRoutes(router, deps)  version-specific HTTP routes
 */
export const BR_PROFILES = ['athena', 'common_core', 'common_public', 'creative', 'collections'];
export const STW_PROFILES = ['campaign', 'metadata', 'theater0', 'outpost0', 'collection_book_people0', 'collection_book_schematics0', 'recycle_bin'];

export const baseAdapter = {
  id: 'base',
  description: 'Shared defaults',
  matches: () => false,
  profileIds: [...BR_PROFILES, ...STW_PROFILES],
  currencyProfile: 'common_core',
  features: {
    // CosmeticLocker:cosmeticlocker_athena item + "loadouts" stat (SetCosmeticLockerSlot era).
    cosmeticLocker: true,
    // Chapter 5+ Locker Service (/api/locker/v4) owns loadouts instead of MCP.
    lockerService: false,
    // Storefront entries carry meta.SectionId / TileSize.
    shopSectionMeta: true,
    // Plain 32-hex access tokens instead of "eg1~" JWTs. Chapter 1 predates eg1 tokens, and
    // 1.8's XMPP rejects the long token as "XMPP log-in credentials not valid".
    legacyTokens: false,
  },
  progression: {
    // XP needed to go from `level` to `level + 1`.
    xpForLevel: () => 80000,
    maxLevel: 200,
    battlePassTiers: 100,
    // 'level' = battle pass tier follows season level; 'stars' = tiers bought with battle stars.
    tierSource: 'level',
    starsPerTier: 10,
    starsForLevel: () => 0,
  },
  athenaStats(build) {
    return {
      season_num: build.season,
      level: 1,
      xp: 0,
      accountLevel: 1,
      book_level: 1,
      book_xp: 0,
      book_purchased: false,
      lifetime_wins: 0,
      season_match_boost: 0,
      season_friend_match_boost: 0,
      favorite_character: '',
      favorite_backpack: '',
      favorite_pickaxe: 'AthenaPickaxe:DefaultPickaxe',
      favorite_glider: 'AthenaGlider:DefaultGlider',
      favorite_skydivecontrail: '',
      favorite_musicpack: '',
      favorite_loadingscreen: '',
      favorite_dance: ['AthenaDance:EID_DanceMoves', '', '', '', '', ''],
      favorite_itemwraps: ['', '', '', '', '', '', ''],
      banner_icon: 'StandardBanner1',
      banner_color: 'DefaultColor1',
      quest_manager: { dailyLoginInterval: '0001-01-01T00:00:00.000Z', dailyQuestRerolls: 1 },
      past_seasons: [],
      season: { numWins: 0, numHighBracket: 0, numLowBracket: 0 },
      battlestars: 0,
      use_random_loadout: false,
      rested_xp: 0,
      rested_xp_mult: 1,
      rested_xp_exchange: 1,
      rested_xp_overflow: 0,
      xp_overflow: 0,
      party_assist_quest: '',
      pinned_quest: '',
      inventory_limit_bonus: 0,
    };
  },
  timelineEvents(build) {
    return [`EventFlag.Season${build.season}`, `EventFlag.LobbySeason${build.season}`];
  },
  timelineState(build, { now, dailyEnd, weeklyEnd, seasonEnd }) {
    return {
      activeStorefronts: [],
      eventNamedWeights: {},
      seasonNumber: build.season,
      seasonTemplateId: `AthenaSeason:athenaseason${build.season}`,
      matchXpBonusPoints: 0,
      seasonBegin: '2017-07-25T00:00:00.000Z',
      seasonEnd,
      seasonDisplayedEnd: seasonEnd,
      weeklyStoreEnd: weeklyEnd,
      stwEventStoreEnd: seasonEnd,
      stwWeeklyStoreEnd: weeklyEnd,
      sectionStoreEnds: { Featured: dailyEnd, Daily: dailyEnd },
      dailyStoreEnd: dailyEnd,
      currentTime: now,
    };
  },
  contentPages(build, pages) {
    return pages;
  },
  catalogEntry(entry) {
    return entry;
  },
  // How this build reaches XMPP when Gallium writes the DefaultEngine.ini hotfix:
  // 'tcp' (raw stream), 'ws' (ws:// URL) or null (leave the build's own setting alone).
  xmppHotfix: null,
  mcpCommands: {},
  registerRoutes: null,
};

export function defineAdapter(def) {
  return {
    ...baseAdapter,
    ...def,
    features: { ...baseAdapter.features, ...(def.features || {}) },
    progression: { ...baseAdapter.progression, ...(def.progression || {}) },
    mcpCommands: { ...baseAdapter.mcpCommands, ...(def.mcpCommands || {}) },
  };
}
