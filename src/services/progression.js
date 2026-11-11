import { Errors } from '../core/errors.js';
import { grantItem } from './profiles/grants.js';

/**
 * XP, season levels and battle pass tiers. The rules (XP per level, tier source, stars) come
 * from the build's version adapter; per-season reward tables and battle pass offers come from
 * data/battlepass/season<N>.json:
 *
 * {
 *   "offers": {
 *     "battlePass": { "offerId": "...", "price": 950 },
 *     "bundle":     { "offerId": "...", "price": 4700, "tiers": 25 },
 *     "tier":       { "offerId": "...", "price": 150 }
 *   },
 *   "tiers": { "1": { "free": [{ "templateId": "...", "quantity": 1 }], "paid": [...] }, ... }
 * }
 */
export function createProgressionService({ dataFiles, cosmetics, log }) {
  const bpLog = log.child('progression');

  function battlePass(season) {
    return dataFiles.read(`battlepass/season${season}.json`);
  }

  function tierRewards(season, tier, paid) {
    const t = battlePass(season)?.tiers?.[String(tier)];
    if (!t) return [];
    return [...(t.free || []), ...(paid ? t.paid || [] : [])].filter((g) => g && typeof g.templateId === 'string');
  }

  function grantTiers(getProfile, build, fromTier, toTier, paid, loot) {
    for (let tier = fromTier; tier <= toTier; tier++) {
      for (const g of tierRewards(build.season, tier, paid)) {
        const entry = grantItem(getProfile, g.templateId, g.quantity || 1, cosmetics);
        if (entry) loot.push(entry);
      }
    }
  }

  /**
   * Add XP to the athena profile, levelling up and advancing the battle pass.
   * @returns {{ levelsGained, tiersGained, loot }}
   */
  function grantXp(getProfile, amount, build) {
    if (!Number.isInteger(amount) || amount < 0) throw Errors.validation('XP amount must be a non-negative integer');
    const athena = getProfile('athena');
    const rule = build.rule;
    const xpForLevel = rule('xpForLevel');
    const starsForLevel = rule('starsForLevel');
    const maxLevel = rule('maxLevel');
    const tiers = rule('battlePassTiers');
    const startLevel = athena.stat('level', 1);
    const startTier = athena.stat('book_level', 1);
    const paid = athena.stat('book_purchased', false) === true;
    const loot = [];

    let level = startLevel;
    let xp = athena.stat('xp', 0) + amount;
    let stars = athena.stat('book_xp', 0);
    let tier = startTier;
    while (level < maxLevel && xp >= xpForLevel(level)) {
      xp -= xpForLevel(level);
      level++;
      if (rule('tierSource') === 'stars') stars += starsForLevel(level);
    }
    if (level >= maxLevel) {
      athena.setStat('xp_overflow', athena.stat('xp_overflow', 0) + xp);
      xp = 0;
    }
    if (rule('tierSource') === 'stars') {
      const per = rule('starsPerTier');
      while (stars >= per && tier < tiers) {
        stars -= per;
        tier++;
      }
      if (tier >= tiers) stars = 0;
    } else {
      tier = Math.max(tier, Math.min(level, tiers));
    }

    athena.setStat('xp', xp);
    if (level !== startLevel) {
      athena.setStat('level', level);
      if ('season_level' in athena.stats) athena.setStat('season_level', level);
      athena.setStat('accountLevel', athena.stat('accountLevel', 1) + (level - startLevel));
    }
    if (stars !== athena.stat('book_xp', 0)) athena.setStat('book_xp', stars);
    if (tier !== startTier) {
      athena.setStat('book_level', tier);
      grantTiers(getProfile, build, startTier + 1, tier, paid, loot);
    }
    if (level !== startLevel || tier !== startTier) bpLog.debug(`${athena.accountId}: level ${startLevel}->${level}, tier ${startTier}->${tier}`);
    return { levelsGained: level - startLevel, tiersGained: tier - startTier, loot };
  }

  function offersFor(build) {
    const bp = battlePass(build.season);
    if (!bp?.offers) return [];
    const out = [];
    for (const kind of ['battlePass', 'bundle', 'tier']) {
      const o = bp.offers[kind];
      if (o && typeof o.offerId === 'string' && Number.isInteger(o.price)) out.push({ kind, ...o });
    }
    return out;
  }

  function checkBattlePassOffer(athena, offer, quantity, build) {
    const tiers = build.rule('battlePassTiers');
    if (offer.kind === 'tier') {
      if (athena.stat('book_level', 1) + quantity > tiers) throw Errors.invalidParameter(`Cannot buy ${quantity} tiers past tier ${tiers}`);
    } else {
      if (quantity !== 1) throw Errors.validation('The battle pass can only be purchased once');
      if (athena.stat('book_purchased', false) === true) throw Errors.alreadyOwned();
    }
  }

  function applyBattlePassOffer(getProfile, offer, quantity, build) {
    const athena = getProfile('athena');
    const tiers = build.rule('battlePassTiers');
    const loot = [];
    const current = athena.stat('book_level', 1);
    if (offer.kind === 'battlePass' || offer.kind === 'bundle') {
      athena.setStat('book_purchased', true);
      // Paid rewards for tiers already reached.
      for (let t = 1; t <= current; t++) {
        for (const g of (battlePass(build.season)?.tiers?.[String(t)]?.paid || [])) {
          const entry = grantItem(getProfile, g.templateId, g.quantity || 1, cosmetics);
          if (entry) loot.push(entry);
        }
      }
    }
    const extra = offer.kind === 'bundle' ? offer.tiers || 25 : offer.kind === 'tier' ? quantity : 0;
    if (extra > 0) {
      const target = Math.min(tiers, current + extra);
      athena.setStat('book_level', target);
      grantTiers(getProfile, build, current + 1, target, athena.stat('book_purchased') === true, loot);
    }
    return loot;
  }

  return { grantXp, offersFor, checkBattlePassOffer, applyBattlePassOffer, battlePass };
}
