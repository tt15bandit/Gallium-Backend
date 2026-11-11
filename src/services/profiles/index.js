import { Profile } from './profile.js';
import { buildTemplate, cosmeticAttributes, lockerItemAttributes, LOCKER_ITEM_ID, LOCKER_TEMPLATE } from './templates.js';
import { DEFAULT_ITEMS } from '../cosmetics.js';
import { balanceOf, mirrorToProfile0 } from './currency.js';
import { isoNow } from '../../core/util.js';

// Athena stats that belong to a single season and are swapped when the client's season changes.
export const SEASONAL_STATS = ['level', 'xp', 'book_level', 'book_xp', 'book_purchased', 'season_match_boost', 'season_friend_match_boost', 'season', 'battlestars', 'xp_overflow', 'rested_xp', 'rested_xp_overflow'];

/**
 * Loads, creates, normalises and persists MCP profiles.
 * Profiles are created lazily from version-aware templates on first access.
 */
export function createProfileService({ db, repos, config, cosmetics, log, cacheSize = 256 }) {
  // Write-through cache of parsed profiles. Every load re-checks the stored rvn/updated pair,
  // so writes from another process (the CLI) are picked up; failed commands evict what they
  // touched (see discard()).
  const cache = new Map();
  const key = (accountId, profileId) => `${accountId}|${profileId}`;

  function cached(accountId, profileId) {
    const header = repos.profiles.header(accountId, profileId);
    if (!header) return { header: null, profile: null };
    const hit = cache.get(key(accountId, profileId));
    if (hit && hit.rvn === header.rvn && hit.updated === header.updated) {
      cache.delete(key(accountId, profileId));
      cache.set(key(accountId, profileId), hit); // LRU bump
      hit.resetTracking();
      return { header, profile: hit };
    }
    return { header, profile: null };
  }

  function remember(profile) {
    const k = key(profile.accountId, profile.profileId);
    cache.delete(k);
    cache.set(k, profile);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }

  function load(accountId, profileId, build) {
    const hit = cached(accountId, profileId);
    let profile = hit.profile;
    if (!profile && hit.header) {
      profile = new Profile(repos.profiles.get(accountId, profileId));
    } else if (!profile) {
      const now = isoNow();
      const { stats, items } = buildTemplate(profileId, build, { config, cosmetics });
      profile = new Profile({ accountId, profileId, rvn: 1, wipeNumber: 1, created: now, updated: now, stats, items }, { isNew: true });
    }
    if (profileId === 'athena') {
      ensureAthenaShape(profile, build);
      syncSeason(profile, build);
    }
    if (profileId === 'profile0' && build.adapter.currencyProfile === 'profile0') {
      const core = repos.profiles.get(accountId, 'common_core');
      const balance = core ? balanceOf(new Profile(core)) : config.accounts.startingVbucks;
      mirrorToProfile0(profile, balance);
    }
    return profile;
  }

  /** Persist pending changes. Bumps rvn once per save that changed something. */
  function save(profile) {
    if (!profile.isNew && !profile.hasChanges) return false;
    db.transaction(() => {
      if (profile.hasChanges) {
        profile.rvn = profile.baseRvn + 1;
        profile.updated = isoNow();
      }
      if (profile.isNew) {
        repos.profiles.insert({ ...profile, items: Object.fromEntries(profile.items) });
      } else {
        repos.profiles.updateHeader(profile);
        for (const id of profile.removedItems) repos.profiles.deleteItem(profile.accountId, profile.profileId, id);
        for (const id of profile.dirtyItems) repos.profiles.upsertItem(profile.accountId, profile.profileId, id, profile.items.get(id));
      }
    });
    profile.isNew = false;
    profile.dirtyItems.clear();
    profile.removedItems.clear();
    profile.statsDirty = false;
    remember(profile);
    return true;
  }

  /** Drop profiles whose in-memory state may not match the database (after a failed command). */
  function discard(list) {
    for (const p of list) cache.delete(key(p.accountId, p.profileId));
  }

  /** Client JSON for a profile, hiding items this build cannot use. */
  function serialize(profile, build, { omissionGroup = null } = {}) {
    const hideLocker = !build.features.cosmeticLocker || omissionGroup === 'Locker';
    const isAthena = profile.profileId === 'athena';
    return profile.toJSON({
      skipItem: (id, item) => {
        if (hideLocker && /^(CosmeticLocker|CosmeticLoadout):/i.test(item.templateId)) return true;
        if (isAthena) {
          const season = cosmetics.seasonOf(item.templateId);
          if (season !== null && season > build.season) return true;
        }
        return false;
      },
    });
  }

  function ensureAthenaShape(profile, build) {
    const defaults = build.adapter.athenaStats(build);
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in profile.stats) && key !== 'season_num') profile.setStat(key, value);
    }
    for (const templateId of DEFAULT_ITEMS) {
      if (!profile.findItem(templateId)) profile.addItem(templateId, templateId, cosmeticAttributes());
    }
    if (build.features.cosmeticLocker && !profile.items.has(LOCKER_ITEM_ID)) {
      profile.addItem(LOCKER_ITEM_ID, LOCKER_TEMPLATE, lockerItemAttributes(profile.stats));
      if (!Array.isArray(profile.stats.loadouts) || !profile.stats.loadouts.length) profile.setStat('loadouts', [LOCKER_ITEM_ID]);
      if (!profile.stats.last_applied_loadout) profile.setStat('last_applied_loadout', LOCKER_ITEM_ID);
      if (!Number.isInteger(profile.stats.active_loadout_index)) profile.setStat('active_loadout_index', 0);
    }
  }

  /** Swap seasonal progression when an account plays a build from a different season. */
  function syncSeason(profile, build) {
    const current = profile.stats.season_num;
    if (current === build.season) return;
    const { accountId } = profile;
    if (Number.isInteger(current)) {
      const snapshot = {};
      for (const key of SEASONAL_STATS) if (key in profile.stats) snapshot[key] = profile.stats[key];
      repos.seasons.put(accountId, current, snapshot);
    }
    const stored = repos.seasons.get(accountId, build.season) || {};
    const defaults = build.adapter.athenaStats(build);
    for (const key of SEASONAL_STATS) profile.setStat(key, key in stored ? stored[key] : defaults[key]);
    profile.setStat('season_num', build.season);
    profile.setStat('past_seasons', pastSeasons(accountId, build.season));
    log.debug(`Account ${accountId}: athena switched from season ${current} to ${build.season}`);
  }

  function pastSeasons(accountId, currentSeason) {
    return repos.seasons
      .list(accountId)
      .filter((s) => s.seasonNumber < currentSeason)
      .map(({ seasonNumber, data }) => ({
        seasonNumber,
        numWins: data.season?.numWins ?? 0,
        numHighBracket: data.season?.numHighBracket ?? 0,
        numLowBracket: data.season?.numLowBracket ?? 0,
        seasonXp: data.xp ?? 0,
        seasonLevel: data.level ?? 1,
        bookXp: data.book_xp ?? 0,
        bookLevel: data.book_level ?? 1,
        purchasedVIP: !!data.book_purchased,
        numRoyalRoyales: 0,
        survivorTier: 0,
        survivorPrestige: 0,
      }));
  }

  /**
   * Run `fn(get)` with a loader that caches profiles, then save everything in one transaction.
   * Used by admin tools and the game-server API (MCP commands use the same pattern).
   */
  function withProfiles(accountId, build, fn) {
    const loaded = new Map();
    try {
      return db.transaction(() => {
        const get = (pid) => {
          if (!loaded.has(pid)) loaded.set(pid, load(accountId, pid, build));
          return loaded.get(pid);
        };
        const result = fn(get);
        for (const p of loaded.values()) save(p);
        return result;
      });
    } catch (err) {
      // The transaction rolled back; in-memory copies touched by fn may be ahead of the DB.
      cache.clear();
      throw err;
    }
  }

  return { load, save, serialize, withProfiles, discard, listIds: (accountId) => repos.profiles.listIds(accountId), clearCache: () => cache.clear() };
}
