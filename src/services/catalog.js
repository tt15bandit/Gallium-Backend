import { seededRandom, sha256Hex, startOfUtcDay } from '../core/util.js';
import { itemType } from './cosmetics.js';

// Standard Item Shop prices by type and rarity, used for auto-rotated offers.
const PRICES = {
  AthenaCharacter: { uncommon: 800, rare: 1200, epic: 1500, legendary: 2000 },
  AthenaBackpack: { uncommon: 200, rare: 300, epic: 400, legendary: 500 },
  AthenaPickaxe: { uncommon: 500, rare: 800, epic: 1200, legendary: 1500 },
  AthenaGlider: { uncommon: 500, rare: 800, epic: 1200, legendary: 1500 },
  AthenaDance: { uncommon: 200, rare: 500, epic: 800, legendary: 800 },
  AthenaItemWrap: { uncommon: 300, rare: 500, epic: 700, legendary: 700 },
};
const ROTATION_TYPES = Object.keys(PRICES);
const RARITIES = ['uncommon', 'rare', 'epic', 'legendary'];

/**
 * Item Shop (storefront v2). Each season has its own shop file, data/shop/season<N>.json,
 * falling back to data/shop.json:
 * {
 *   "featured": [{ "items": ["AthenaCharacter:CID_..."], "price": 1500 }],
 *   "daily":    [{ "items": ["AthenaPickaxe:..."], "price": 800 }],
 *   "season":   [{ "items": ["AthenaCharacter:CID_028_Athena_Commando_F"], "price": 1200, "seasonLevel": 20 }],
 *   "rotation": { "enabled": false, "featured": 4, "daily": 6, "pool": ["AthenaCharacter:...", ...] }
 * }
 * "featured" -> BRWeeklyStorefront, "daily" -> BRDailyStorefront, "season" -> BRSeasonStorefront
 * (the Season Shop tab; storefront names taken from the 1.8 game files). Season Shop offers can
 * require a season level / wins via the SeasonLevelReq / SeasonWinsReq meta keys the client reads.
 * Optional rotation adds random offers each UTC day from cosmetics the build's season can use.
 */
export function createCatalogService({ dataFiles, cosmetics, progression, vbucksStore = null, config = null, log }) {
  const cache = new Map();

  function dayBounds() {
    const start = startOfUtcDay();
    return { dayKey: start.toISOString().slice(0, 10), expiration: new Date(start.getTime() + 86400000).toISOString() };
  }

  function priceFor(templateId) {
    const def = cosmetics.lookup(templateId);
    const table = PRICES[itemType(templateId)];
    const rarity = def?.rarity && RARITIES.includes(def.rarity) ? def.rarity : 'rare';
    return table?.[rarity] ?? 500;
  }

  function makeEntry(templateIds, price, section, build, dayKey, sortPriority, reqs = {}) {
    const devName = `[VIRTUAL]1 x ${templateIds.join(', ')} for ${price} MtxCurrency`;
    const tileSize = section === 'Featured' ? 'Normal' : 'Small';
    const entry = {
      devName,
      offerId: `v2:/${sha256Hex(`${devName}|${section}|${dayKey}`)}`,
      fulfillmentIds: [],
      dailyLimit: -1,
      weeklyLimit: -1,
      monthlyLimit: -1,
      categories: [],
      prices: [{ currencyType: 'MtxCurrency', currencySubType: '', regularPrice: price, dynamicRegularPrice: -1, finalPrice: price, saleExpiration: '9999-12-31T23:59:59.999Z', basePrice: price }],
      matchFilter: '',
      filterWeight: 0,
      appStoreId: [],
      requirements: templateIds.map((t) => ({ requirementType: 'DenyOnItemOwnership', requiredId: t, minQuantity: 1 })),
      offerType: 'StaticPrice',
      giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: '', purchaseRequirements: [], giftRecordIds: [] },
      refundable: true,
      displayAssetPath: '',
      itemGrants: templateIds.map((t) => ({ templateId: t, quantity: 1 })),
      sortPriority,
      catalogGroupPriority: 0,
    };
    // 1.8 rejects the whole catalog ("0 total offers") when entries carry a "meta" object, so
    // older builds only get the metaInfo key/value list; newer builds get both.
    const meta = {};
    if (build.features.shopSectionMeta) Object.assign(meta, { SectionId: section, TileSize: tileSize });
    if (Number.isInteger(reqs.seasonLevel) && reqs.seasonLevel > 0) meta.SeasonLevelReq = String(reqs.seasonLevel);
    if (Number.isInteger(reqs.seasonWins) && reqs.seasonWins > 0) meta.SeasonWinsReq = String(reqs.seasonWins);
    entry.metaInfo = Object.entries(meta).map(([key, value]) => ({ key, value }));
    if (build.features.shopSectionMeta) entry.meta = meta;
    return build.adapter.catalogEntry(entry, build);
  }

  /**
   * Daily picks. With `explicitPool` (rotation.pool in the shop file) only those items are used,
   * e.g. exactly the cosmetics that exist in a given build; otherwise every cosmetic introduced
   * by the build's season.
   */
  function rotationPicks(build, dayKey, featuredCount, dailyCount, exclude, explicitPool = null) {
    const source = Array.isArray(explicitPool) && explicitPool.length
      ? explicitPool.filter((t) => typeof t === 'string' && t.includes(':'))
      : cosmetics.forSeason(build.season).map((def) => cosmetics.templateIdOf(def));
    const pool = source.filter((t) => ROTATION_TYPES.includes(itemType(t)) && !exclude.has(t.toLowerCase()) && !/:(EID_DanceMoves|DefaultPickaxe|DefaultGlider)$/i.test(t));
    const rand = seededRandom(`${dayKey}:${build.season}`);
    const take = (filter, n) => {
      const candidates = pool.filter(filter);
      const out = [];
      while (out.length < n && candidates.length) {
        const pick = candidates.splice(Math.floor(rand() * candidates.length), 1)[0];
        out.push(pick);
        pool.splice(pool.indexOf(pick), 1);
      }
      return out;
    };
    return {
      featured: take((t) => itemType(t) === 'AthenaCharacter', featuredCount),
      daily: take(() => true, dailyCount),
    };
  }

  function build_(build) {
    const { dayKey, expiration } = dayBounds();
    const config = dataFiles.first(`shop/season${build.season}.json`, 'shop.json') || {};
    const bpConfig = progression.battlePass(build.season);
    const key = `${dayKey}|${build.season}|${build.adapter.id}|${build.features.shopSectionMeta}|${cosmetics.count}|${sha256Hex(JSON.stringify([config, bpConfig?.offers ?? null]))}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const manual = (list) => (Array.isArray(list) ? list : []).filter((e) => Array.isArray(e?.items) && e.items.length && Number.isInteger(e.price) && e.price >= 0);
    const featuredManual = manual(config.featured);
    const dailyManual = manual(config.daily);
    const seasonManual = manual(config.season);
    const used = new Set([...featuredManual, ...dailyManual, ...seasonManual].flatMap((e) => e.items.map((t) => t.toLowerCase())));
    const rotation = config.rotation || {};
    const picks = rotation.enabled === true ? rotationPicks(build, dayKey, rotation.featured ?? 4, rotation.daily ?? 6, used, rotation.pool) : { featured: [], daily: [] };

    let sort = 0;
    const featured = [
      ...featuredManual.map((e) => makeEntry(e.items, e.price, 'Featured', build, dayKey, sort--)),
      ...picks.featured.map((t) => makeEntry([t], priceFor(t), 'Featured', build, dayKey, sort--)),
    ];
    const daily = [
      ...dailyManual.map((e) => makeEntry(e.items, e.price, 'Daily', build, dayKey, sort--)),
      ...picks.daily.map((t) => makeEntry([t], priceFor(t), 'Daily', build, dayKey, sort--)),
    ];
    const seasonShop = seasonManual.map((e) => makeEntry(e.items, e.price, 'Season', build, dayKey, sort--, { seasonLevel: e.seasonLevel, seasonWins: e.seasonWins }));
    const requirements = new Map();
    for (const [i, e] of seasonManual.entries()) requirements.set(seasonShop[i].offerId, { seasonLevel: e.seasonLevel || 0, seasonWins: e.seasonWins || 0 });
    const storefronts = [
      { name: 'BRWeeklyStorefront', catalogEntries: featured },
      { name: 'BRDailyStorefront', catalogEntries: daily },
      { name: 'BRSeasonStorefront', catalogEntries: seasonShop },
    ];
    if (vbucksStore && build.features.vbucksStore && config?.store?.fakeVbucksPurchases !== false) {
      storefronts.push({ name: 'CurrencyStorefront', catalogEntries: vbucksStore.catalogEntries() });
    }
    const bpOffers = progression.offersFor(build);
    const battlePassById = new Map();
    if (bpOffers.length) {
      storefronts.push({
        name: `BRSeason${build.season}`,
        catalogEntries: bpOffers.map((o) => {
          battlePassById.set(o.offerId, o);
          const e = makeEntry([], o.price, 'BattlePass', build, dayKey, 0);
          return { ...e, offerId: o.offerId, devName: `BR.Season${build.season}.${o.kind}`, requirements: [], itemGrants: [], giftInfo: { ...e.giftInfo, bIsEnabled: false }, refundable: false };
        }),
      });
    }
    const catalog = { refreshIntervalHrs: 24, dailyPurchaseHrs: 24, expiration, storefronts };
    const result = { catalog, battlePassById, requirements };
    if (cache.size > 64) cache.clear();
    cache.set(key, result);
    return result;
  }

  return {
    get: (build) => build_(build).catalog,
    defaultPrice: priceFor,
    findOffer(offerId, build) {
      const { catalog, battlePassById, requirements } = build_(build);
      for (const sf of catalog.storefronts) {
        const entry = sf.catalogEntries.find((e) => e.offerId === offerId);
        if (entry) return { entry, storefront: sf.name, battlePass: battlePassById.get(offerId) || null, requirements: requirements.get(offerId) || null };
      }
      return null;
    },
    clearCache: () => cache.clear(),
  };
}
