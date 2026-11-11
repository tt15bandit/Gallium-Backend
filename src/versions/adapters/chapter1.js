import { defineAdapter } from './base.js';
import { atLeast } from '../buildInfo.js';
import { stwCompatCommands } from '../../services/mcp/commands/stwCompat.js';

/**
 * Fortnite 3.5 through 10.x (rest of Chapter 1).
 * Observed traffic (4.5, 5.41): common_core holds currency, EquipBattleRoyaleCustomization and
 * BulkEquipBattleRoyaleCustomization manage the locker, STW lives in "campaign".
 * The CosmeticLocker item (SetCosmeticLockerSlot) is only added for 7.0+ builds.
 */
export default defineAdapter({
  id: 'chapter1',
  description: 'Fortnite 3.5 - 10.x (Chapter 1)',
  matches: (b) => atLeast(b, 3, 5) && b.season <= 10,
  features: { cosmeticLocker: (b) => atLeast(b, 7, 0), shopSectionMeta: false, legacyTokens: true },
  progression: {
    maxLevel: 100,
    battlePassTiers: 100,
    tierSource: 'stars',
    starsPerTier: 10,
    starsForLevel: (level) => (level % 5 === 0 ? 10 : 5),
  },
  // Observed: 4.5 used raw TCP XMPP, 5.41 used ws://.
  xmppHotfix: (b) => (atLeast(b, 5, 0) ? 'ws' : 'tcp'),
  mcpCommands: { ...stwCompatCommands },
});
