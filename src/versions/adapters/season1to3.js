import { defineAdapter } from './base.js';
import { atLeast } from '../buildInfo.js';
import { stwCompatCommands } from '../../services/mcp/commands/stwCompat.js';

/**
 * Fortnite 1.x (incl. "Cert" builds) through 3.4.
 * Observed traffic (1.x Cert, 3.1): Save the World data lives in "profile0" (no campaign /
 * common_core split yet), lockers use EquipBattleRoyaleCustomization, and old builds also call
 * IssueFriendCode / RefreshExpeditions / IncrementNamedCounterStat on profile0.
 */
export default defineAdapter({
  id: 'season1-3',
  description: 'Fortnite 1.x - 3.4 (profile0 era)',
  matches: (b) => !atLeast(b, 3, 5),
  profileIds: ['athena', 'profile0', 'common_core', 'common_public', 'creative', 'collections', 'metadata', 'theater0', 'outpost0', 'collection_book_people0', 'collection_book_schematics0', 'campaign'],
  currencyProfile: 'profile0',
  features: { cosmeticLocker: false, shopSectionMeta: false },
  progression: {
    maxLevel: 100,
    battlePassTiers: (b) => (b.season <= 2 ? 70 : 100),
    tierSource: 'stars',
    starsPerTier: 10,
    starsForLevel: (level) => (level % 5 === 0 ? 10 : 5),
  },
  mcpCommands: { ...stwCompatCommands },
});
