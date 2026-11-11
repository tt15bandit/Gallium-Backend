import { DEFAULT_ITEMS, SLOT_SIZES } from '../cosmetics.js';

export const LOCKER_ITEM_ID = 'sandbox_loadout';
export const LOCKER_TEMPLATE = 'CosmeticLocker:cosmeticlocker_athena';

export const FAVORITE_STAT = {
  Character: 'favorite_character',
  Backpack: 'favorite_backpack',
  Pickaxe: 'favorite_pickaxe',
  Glider: 'favorite_glider',
  SkyDiveContrail: 'favorite_skydivecontrail',
  MusicPack: 'favorite_musicpack',
  LoadingScreen: 'favorite_loadingscreen',
  Dance: 'favorite_dance',
  ItemWrap: 'favorite_itemwraps',
};

export function cosmeticAttributes(variants = []) {
  return { max_level_bonus: 0, level: 1, item_seen: false, xp: 0, variants, favorite: false };
}

/** Locker slot data mirroring the athena favorite_* stats. */
export function lockerSlotsFromStats(stats) {
  const slots = {};
  for (const [slot, statName] of Object.entries(FAVORITE_STAT)) {
    const size = SLOT_SIZES[slot] || 1;
    const value = stats[statName];
    const list = Array.isArray(value) ? value : [value || ''];
    const items = Array.from({ length: size }, (_, i) => list[i] || '');
    slots[slot] = { items, activeVariants: items.map(() => null) };
  }
  return slots;
}

export function lockerItemAttributes(stats) {
  return {
    locker_slots_data: { slots: lockerSlotsFromStats(stats) },
    use_count: 0,
    banner_icon_template: stats.banner_icon || 'StandardBanner1',
    banner_color_template: stats.banner_color || 'DefaultColor1',
    locker_name: '',
    item_seen: false,
    favorite: false,
  };
}

function commonCoreStats() {
  return {
    survey_data: {},
    personal_offers: {},
    intro_game_played: true,
    import_friends_claimed: {},
    mtx_purchase_history: { refundsUsed: 0, refundCredits: 3, purchases: [] },
    undo_cooldowns: [],
    mtx_affiliate_set_time: '',
    inventory_limit_bonus: 0,
    current_mtx_platform: 'EpicPC',
    mtx_affiliate: '',
    weekly_purchases: {},
    daily_purchases: {},
    ban_history: {},
    in_app_purchases: {},
    permissions: [],
    undo_timeout: 'min',
    monthly_purchases: {},
    allowed_to_send_gifts: true,
    mfa_enabled: true,
    allowed_to_receive_gifts: true,
    gift_history: {},
  };
}

/**
 * Initial contents of a profile for the given build.
 * @returns {{ stats: object, items: object }}
 */
export function buildTemplate(profileId, build, { config, cosmetics }) {
  const adapter = build.adapter;
  const items = {};
  let stats = {};

  const addCurrency = () => {
    // "Shared" counts on every MTX platform (old builds don't necessarily consider themselves EpicPC).
    items['Currency:MtxPurchased'] = { templateId: 'Currency:MtxPurchased', attributes: { platform: 'Shared' }, quantity: config.accounts.startingVbucks };
  };

  switch (profileId) {
    case 'athena': {
      stats = adapter.athenaStats(build);
      for (const templateId of DEFAULT_ITEMS) items[templateId] = { templateId, attributes: cosmeticAttributes(), quantity: 1 };
      if (config.accounts.grantAllCosmetics) {
        for (const def of cosmetics.all()) {
          const templateId = cosmetics.templateIdOf(def);
          items[templateId] = { templateId, attributes: cosmeticAttributes(cosmetics.allVariants(templateId)), quantity: 1 };
        }
      }
      if (build.features.cosmeticLocker) {
        items[LOCKER_ITEM_ID] = { templateId: LOCKER_TEMPLATE, attributes: lockerItemAttributes(stats), quantity: 1 };
        Object.assign(stats, { loadouts: [LOCKER_ITEM_ID], last_applied_loadout: LOCKER_ITEM_ID, active_loadout_index: 0 });
      }
      break;
    }
    case 'common_core':
      // common_core is the source of truth for V-Bucks on every build (profile0 mirrors it on old builds).
      stats = commonCoreStats();
      addCurrency();
      if (config.accounts.grantAllCosmetics) {
        for (const id of cosmetics.banners()) items[`HomebaseBannerIcon:${id}`] = { templateId: `HomebaseBannerIcon:${id}`, attributes: { item_seen: true }, quantity: 1 };
        for (const id of cosmetics.bannerColors()) items[`HomebaseBannerColor:${id}`] = { templateId: `HomebaseBannerColor:${id}`, attributes: { item_seen: true }, quantity: 1 };
      }
      break;
    case 'profile0':
      stats = { mtx_purchase_history: { refundsUsed: 0, refundCredits: 3, purchases: [] }, current_mtx_platform: 'EpicPC', named_counters: {} };
      if (adapter.currencyProfile === 'profile0') addCurrency();
      break;
    case 'common_public':
      stats = { banner_color: 'DefaultColor1', homebase_name: '', banner_icon: 'StandardBanner1' };
      break;
    case 'creative':
      stats = { last_used_project: '', max_island_plots: 50, publish_allowed: true, support_code: '', last_used_plot: '', permissions: [], creator_name: '', publish_banned: false, inventory_limit_bonus: 0 };
      break;
    default:
      stats = {};
  }
  return { stats, items };
}
