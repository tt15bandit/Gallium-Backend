import fs from 'node:fs';
import path from 'node:path';

/**
 * Cosmetic definitions. Gallium ships without Epic's item list; `npm run sync-cosmetics`
 * downloads it once (from the public fortnite-api.com dataset) into data/cosmetics.json,
 * and everything works offline from then on. Without the file only the default
 * pickaxe / glider / emote exist.
 *
 * data/cosmetics.json:
 * { "generatedAt": "...", "items": [{ "id", "type", "season", "rarity", "variants": [{ "channel", "options": [tag] }] }],
 *   "banners": ["StandardBanner1", ...], "bannerColors": ["DefaultColor1", ...] }
 */
export const DEFAULT_ITEMS = ['AthenaPickaxe:DefaultPickaxe', 'AthenaGlider:DefaultGlider', 'AthenaDance:EID_DanceMoves'];

// MCP slot name (EquipBattleRoyaleCustomization / SetCosmeticLockerSlot "category") -> item type prefix.
export const SLOT_TYPES = {
  Character: ['AthenaCharacter'],
  Backpack: ['AthenaBackpack', 'AthenaPetCarrier', 'AthenaPet'],
  Pickaxe: ['AthenaPickaxe'],
  Glider: ['AthenaGlider'],
  SkyDiveContrail: ['AthenaSkyDiveContrail'],
  Dance: ['AthenaDance', 'AthenaEmoji', 'AthenaSpray', 'AthenaToy'],
  ItemWrap: ['AthenaItemWrap'],
  MusicPack: ['AthenaMusicPack'],
  LoadingScreen: ['AthenaLoadingScreen'],
};

export const SLOT_SIZES = { Dance: 6, ItemWrap: 7 };

export function createCosmeticsService({ config, log }) {
  const file = path.join(config.data.dir, 'cosmetics.json');
  let items = [];
  let banners = [];
  let bannerColors = [];
  let byTemplate = new Map();

  function load() {
    items = [];
    banners = [];
    bannerColors = [];
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        items = Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.id === 'string' && typeof i.type === 'string') : [];
        banners = Array.isArray(data.banners) ? data.banners : [];
        bannerColors = Array.isArray(data.bannerColors) ? data.bannerColors : [];
        log.info(`Loaded ${items.length} cosmetics, ${banners.length} banners from ${path.relative(config.rootDir, file)}`);
      } catch (err) {
        log.error(`Could not parse ${file}: ${err.message}. Continuing with default items only.`);
      }
    } else {
      log.info('No data/cosmetics.json found - only default cosmetics are available. Run "npm run sync-cosmetics" to download the item list.');
    }
    byTemplate = new Map(items.map((i) => [templateIdOf(i).toLowerCase(), i]));
  }

  load();

  return {
    reload: load,
    get count() {
      return items.length;
    },
    templateIdOf,
    /** Definition for a templateId (case-insensitive), or null if unknown. */
    lookup: (templateId) => byTemplate.get(String(templateId).toLowerCase()) || null,
    /** Season an item was introduced in, or null when unknown. */
    seasonOf(templateId) {
      const def = byTemplate.get(String(templateId).toLowerCase());
      return def && Number.isInteger(def.season) ? def.season : null;
    },
    /** All cosmetics usable on a build of the given season (unknown-season items excluded). */
    forSeason(season) {
      return items.filter((i) => Number.isInteger(i.season) && i.season <= season);
    },
    all: () => items,
    banners: () => banners,
    bannerColors: () => bannerColors,
    /** Profile "variants" attribute granting every option of every channel. */
    allVariants(templateId) {
      const def = byTemplate.get(String(templateId).toLowerCase());
      if (!def || !Array.isArray(def.variants)) return [];
      return def.variants
        .filter((v) => v.channel && Array.isArray(v.options) && v.options.length)
        .map((v) => ({ channel: v.channel, active: v.options[0], owned: [...v.options] }));
    },
  };
}

export function templateIdOf(item) {
  return `${item.type}:${item.id}`;
}

export function itemType(templateId) {
  const i = String(templateId).indexOf(':');
  return i === -1 ? '' : templateId.slice(0, i);
}

export function isCosmeticType(templateId) {
  const type = itemType(templateId);
  return Object.values(SLOT_TYPES).some((types) => types.includes(type));
}
