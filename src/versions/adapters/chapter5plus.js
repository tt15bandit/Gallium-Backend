import { defineAdapter } from './base.js';
import chapter2to4 from './chapter2to4.js';

/**
 * Season 28+ (Chapter 5 onward).
 * Observed traffic (32.00, 37.20): loadouts come from the Locker Service
 * (/api/locker/v4/...), athena is queried with dataOmissionGroup=Locker, and the MCP "rvn"
 * query parameter carries profileCommandRevision.
 */
export default defineAdapter({
  id: 'chapter5plus',
  description: 'Season 28+ (Chapter 5 onward, Locker Service era)',
  matches: (b) => b.season >= 28,
  features: { cosmeticLocker: true, lockerService: true },
  progression: { maxLevel: 200, battlePassTiers: 100, tierSource: 'level' },
  contentPages: chapter2to4.contentPages,
});
