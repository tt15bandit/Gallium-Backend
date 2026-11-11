import { Errors } from '../core/errors.js';
import { balanceOf, mirrorToProfile0, setBalance } from './profiles/currency.js';
import { grantItem, revokeItem } from './profiles/grants.js';

/**
 * Account administration shared by the CLI (scripts/cli.js) and the HTTP admin API, so both
 * go through exactly the same logic.
 */
export function createAdminService({ accounts, profiles, auth, versions, cosmetics, progression, stats, quests }) {
  function buildFor(account, buildText) {
    if (buildText) {
      const b = versions.fromBuildString(buildText);
      if (!b) throw Errors.validation(`Unrecognised build "${buildText}"`);
      return b;
    }
    return (account.lastBuild && versions.fromBuildString(account.lastBuild)) || versions.fallback;
  }

  function resolve(idOrName) {
    const a = accounts.get(idOrName) || accounts.byDisplayName(idOrName) || accounts.byEmail(idOrName);
    if (!a) throw Errors.accountNotFound(idOrName);
    return a;
  }

  function syncLegacyMirror(get, build) {
    if (build.adapter.currencyProfile === 'profile0') mirrorToProfile0(get('profile0'), balanceOf(get('common_core')));
  }

  return {
    resolve,
    createAccount: (opts) => accounts.create(opts),
    exchangeCode: (idOrName) => auth.createExchangeCode(resolve(idOrName).id, 'gallium-admin'),
    setPassword: (idOrName, pw) => accounts.setPassword(resolve(idOrName).id, pw),
    setBanned(idOrName, banned) {
      const a = resolve(idOrName);
      accounts.setBanned(a.id, banned);
      if (banned) auth.killSessions({ accountId: a.id, sessionId: '' }, 'ALL');
    },
    deleteAccount: (idOrName) => accounts.delete(resolve(idOrName).id),

    grantItems(idOrName, templateIds, buildText) {
      const a = resolve(idOrName);
      const build = buildFor(a, buildText);
      return profiles.withProfiles(a.id, build, (get) => templateIds.map((t) => grantItem(get, t, 1, cosmetics)).filter(Boolean).map((l) => l.itemType));
    },
    revokeItems(idOrName, templateIds, buildText) {
      const a = resolve(idOrName);
      return profiles.withProfiles(a.id, buildFor(a, buildText), (get) => templateIds.filter((t) => revokeItem(get, t)));
    },
    grantAllCosmetics(idOrName, buildText) {
      const a = resolve(idOrName);
      const build = buildFor(a, buildText);
      const all = cosmetics.all().map((d) => cosmetics.templateIdOf(d));
      const banners = cosmetics.banners().map((b) => `HomebaseBannerIcon:${b}`).concat(cosmetics.bannerColors().map((c) => `HomebaseBannerColor:${c}`));
      return profiles.withProfiles(a.id, build, (get) => [...all, ...banners].map((t) => grantItem(get, t, 1, cosmetics)).filter(Boolean).length);
    },
    setVbucks(idOrName, amount, { add = false } = {}) {
      if (!Number.isInteger(amount)) throw Errors.validation('amount must be an integer');
      const a = resolve(idOrName);
      const build = buildFor(a);
      return profiles.withProfiles(a.id, build, (get) => {
        const core = get('common_core');
        const target = add ? balanceOf(core) + amount : amount;
        if (target < 0) throw Errors.validation('V-Bucks balance cannot be negative');
        setBalance(core, target);
        syncLegacyMirror(get, build);
        return balanceOf(core);
      });
    },
    addXp(idOrName, amount, buildText) {
      const a = resolve(idOrName);
      const build = buildFor(a, buildText);
      return profiles.withProfiles(a.id, build, (get) => {
        const r = progression.grantXp(get, amount, build);
        const athena = get('athena');
        return { ...r, level: athena.stat('level'), xp: athena.stat('xp'), tier: athena.stat('book_level') };
      });
    },
    setBattlePass(idOrName, owned, buildText) {
      const a = resolve(idOrName);
      return profiles.withProfiles(a.id, buildFor(a, buildText), (get) => get('athena').setStat('book_purchased', !!owned));
    },
    /** Apply one player's match result reported by a game server. */
    recordMatchResult(accountId, result) {
      const a = accounts.require(accountId);
      const build = buildFor(a);
      stats.recordMatch(a.id, result);
      return profiles.withProfiles(a.id, build, (get) => {
        const out = { xp: null, completedQuests: [] };
        if (result.xp !== undefined) out.xp = progression.grantXp(get, result.xp, build);
        if (result.placement === 1) {
          const athena = get('athena');
          athena.setStat('lifetime_wins', athena.stat('lifetime_wins', 0) + 1);
          const season = { ...(athena.stat('season') || {}) };
          season.numWins = (season.numWins || 0) + 1;
          athena.setStat('season', season);
          if ('season_wins' in athena.stats) athena.setStat('season_wins', season.numWins);
        }
        for (const [objective, count] of Object.entries(result.questProgress || {})) {
          if (!Number.isInteger(count) || count < 0) throw Errors.validation(`questProgress.${objective} must be a non-negative integer`);
          out.completedQuests.push(...quests.progress(get, 'athena', objective, count, build));
        }
        return out;
      });
    },
    describe(idOrName) {
      const a = resolve(idOrName);
      const build = buildFor(a);
      return profiles.withProfiles(a.id, build, (get) => {
        const athena = get('athena');
        return {
          id: a.id,
          displayName: a.displayName,
          email: a.email,
          createdAt: a.createdAt,
          lastLogin: a.lastLogin,
          lastBuild: a.lastBuild,
          banned: a.banned,
          vbucks: balanceOf(get('common_core')),
          shownForBuild: a.lastBuild ? build.raw : `${build.raw} (fallback - account has not logged in yet)`,
          season: athena.stat('season_num'),
          level: athena.stat('level'),
          battlePassTier: athena.stat('book_level'),
          battlePassOwned: athena.stat('book_purchased'),
          athenaItems: athena.items.size,
        };
      });
    },
  };
}
