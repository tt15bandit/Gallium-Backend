import { defineAdapter } from './base.js';

/**
 * Seasons 11-27 (Chapters 2-4).
 * Observed traffic (14.60, 21.50): SetCosmeticLockerSlot lockers, eulatracking + content-controls
 * checks at login, RedeemRealMoneyPurchases on common_core. Battle pass tiers follow season level.
 */
export default defineAdapter({
  id: 'chapter2-4',
  description: 'Seasons 11 - 27 (Chapters 2-4)',
  matches: (b) => b.season >= 11 && b.season <= 27,
  features: { cosmeticLocker: true },
  progression: {
    maxLevel: 200,
    battlePassTiers: 100,
    tierSource: 'level',
  },
  contentPages(build, pages) {
    pages.dynamicbackgrounds = {
      backgrounds: {
        backgrounds: [
          { stage: `season${build.season}`, _type: 'DynamicBackground', key: 'lobby' },
          { stage: `season${build.season}`, _type: 'DynamicBackground', key: 'vault' },
        ],
        _type: 'DynamicBackgroundList',
      },
      _title: 'dynamicbackgrounds',
      _noIndex: false,
      _activeDate: pages._activeDate,
      lastModified: pages.lastModified,
      _locale: 'en-US',
    };
    return pages;
  },
});
