import { Errors } from '../../../core/errors.js';
import { deepClone, guid } from '../../../core/util.js';
import { SLOT_TYPES, SLOT_SIZES, itemType } from '../../cosmetics.js';
import { FAVORITE_STAT, LOCKER_TEMPLATE, lockerSlotsFromStats } from '../../profiles/templates.js';
import { command, optionalString, requireArray, requireInt, requireString } from './helpers.js';

const SLOT_NAMES = Object.keys(FAVORITE_STAT);

function normalizeSlot(name) {
  const slot = SLOT_NAMES.find((s) => s.toLowerCase() === String(name || '').toLowerCase());
  if (!slot) throw Errors.validation(`Unknown cosmetic slot "${name}"`);
  return slot;
}

/** Resolve the item being equipped; '' (empty) means "unequip". Returns { id, templateId } or null. */
function resolveSlotItem(profile, itemToSlot, slot) {
  if (!itemToSlot) return null;
  const entry = profile.findItem(itemToSlot);
  if (!entry) throw Errors.itemNotFound(itemToSlot);
  const type = itemType(entry.item.templateId);
  if (!SLOT_TYPES[slot].some((t) => t.toLowerCase() === type.toLowerCase())) {
    throw Errors.invalidParameter(`Item ${entry.item.templateId} cannot be equipped in slot ${slot}`);
  }
  return { id: entry.id, templateId: entry.item.templateId };
}

function slotIndices(slot, index) {
  const size = SLOT_SIZES[slot] || 1;
  if (slot === 'ItemWrap' && index === -1) return Array.from({ length: size }, (_, i) => i);
  if (!Number.isInteger(index) || index < 0 || index >= size) throw Errors.validation(`Index ${index} is out of range for slot ${slot}`);
  return [index];
}

/** Apply variantUpdates [{channel, active, owned}] to an item's "variants" attribute. */
function applyVariants(profile, itemId, updates) {
  if (!Array.isArray(updates) || !updates.length) return [];
  const item = profile.items.get(itemId);
  const variants = deepClone(item.attributes.variants || []);
  const applied = [];
  for (const u of updates) {
    if (!u || typeof u.channel !== 'string' || typeof u.active !== 'string') throw Errors.validation('variantUpdates entries need string "channel" and "active"');
    const existing = variants.find((v) => v.channel === u.channel);
    if (existing) {
      if (Array.isArray(existing.owned) && existing.owned.length && !existing.owned.includes(u.active)) {
        throw Errors.invalidParameter(`Variant ${u.channel}:${u.active} is not owned for ${item.templateId}`);
      }
      existing.active = u.active;
    } else {
      variants.push({ channel: u.channel, active: u.active, owned: [u.active] });
    }
    applied.push({ channel: u.channel, active: u.active });
  }
  profile.setItemAttr(itemId, 'variants', variants);
  return applied;
}

function setFavorite(profile, slot, indices, value) {
  const stat = FAVORITE_STAT[slot];
  if (SLOT_SIZES[slot]) {
    const size = SLOT_SIZES[slot];
    const current = Array.isArray(profile.stat(stat)) ? profile.stat(stat) : [];
    const arr = Array.from({ length: size }, (_, i) => current[i] || '');
    for (const i of indices) arr[i] = value;
    profile.setStat(stat, arr);
  } else {
    profile.setStat(stat, value);
  }
}

function activeLockerId(profile) {
  const loadouts = profile.stat('loadouts');
  const index = profile.stat('active_loadout_index', 0);
  return (Array.isArray(loadouts) && loadouts[index]) || profile.stat('last_applied_loadout') || null;
}

function updateLockerSlot(profile, lockerId, slot, indices, templateId, variants) {
  const locker = profile.items.get(lockerId);
  const data = deepClone(locker.attributes.locker_slots_data || { slots: {} });
  data.slots = data.slots || {};
  const size = SLOT_SIZES[slot] || 1;
  const entry = data.slots[slot] || { items: [], activeVariants: [] };
  entry.items = Array.from({ length: size }, (_, i) => entry.items?.[i] || '');
  entry.activeVariants = Array.from({ length: size }, (_, i) => entry.activeVariants?.[i] ?? null);
  for (const i of indices) {
    entry.items[i] = templateId;
    entry.activeVariants[i] = variants ? { variants } : null;
  }
  data.slots[slot] = entry;
  profile.setItemAttr(lockerId, 'locker_slots_data', data);
}

/** Shared equip logic for the old (favorite_* stats) and new (CosmeticLocker item) locker styles. */
function equip(profile, { slotName, itemToSlot, index, variantUpdates, lockerId = null }) {
  const slot = normalizeSlot(slotName);
  const indices = slotIndices(slot, index);
  const target = resolveSlotItem(profile, itemToSlot, slot);
  const variants = target ? applyVariants(profile, target.id, variantUpdates) : [];
  const locker = lockerId || (profile.items.has(activeLockerId(profile)) ? activeLockerId(profile) : null);
  if (locker) updateLockerSlot(profile, locker, slot, indices, target ? target.templateId : '', variants.length ? variants : null);
  // Mirror into favorite_* so builds/game servers that read the stats see the same loadout.
  if (!lockerId || lockerId === activeLockerId(profile)) setFavorite(profile, slot, indices, target ? target.id : '');
}

export const lockerCommands = {
  EquipBattleRoyaleCustomization: command(
    (cmd) => {
      const b = cmd.body;
      equip(cmd.profile, {
        slotName: requireString(b, 'slotName', { max: 64 }),
        itemToSlot: optionalString(b, 'itemToSlot'),
        index: requireInt(b, 'indexWithinSlot', { min: -1, max: 6, fallback: 0 }),
        variantUpdates: b.variantUpdates,
      });
    },
    { profiles: ['athena'] },
  ),

  BulkEquipBattleRoyaleCustomization: command(
    (cmd) => {
      const entries = requireArray(cmd.body, 'loadoutData', { max: 64 });
      for (const e of entries) {
        if (!e || typeof e !== 'object') throw Errors.validation('loadoutData entries must be objects');
        equip(cmd.profile, {
          slotName: requireString(e, 'slotName', { max: 64 }),
          itemToSlot: optionalString(e, 'itemToSlot'),
          index: requireInt(e, 'indexWithinSlot', { min: -1, max: 6, fallback: 0 }),
          variantUpdates: e.variantUpdates,
        });
      }
    },
    { profiles: ['athena'] },
  ),

  SetCosmeticLockerSlot: command(
    (cmd) => {
      const b = cmd.body;
      const lockerId = requireString(b, 'lockerItem', { max: 128 });
      const locker = cmd.profile.findItem(lockerId);
      if (!locker || !locker.item.templateId.toLowerCase().startsWith('cosmeticlocker:')) throw Errors.itemNotFound(lockerId);
      equip(cmd.profile, {
        slotName: requireString(b, 'category', { max: 64 }),
        itemToSlot: optionalString(b, 'itemToSlot'),
        index: requireInt(b, 'slotIndex', { min: -1, max: 6, fallback: 0 }),
        variantUpdates: b.variantUpdates,
        lockerId: locker.id,
      });
    },
    { profiles: ['athena', 'campaign'] },
  ),

  SetCosmeticLockerBanner: command(
    (cmd) => {
      const b = cmd.body;
      const locker = cmd.profile.findItem(requireString(b, 'lockerItem', { max: 128 }));
      if (!locker) throw Errors.itemNotFound(b.lockerItem);
      const icon = requireString(b, 'bannerIconTemplateName', { max: 128 });
      const color = requireString(b, 'bannerColorTemplateName', { max: 128 });
      cmd.profile.setItemAttr(locker.id, 'banner_icon_template', icon);
      cmd.profile.setItemAttr(locker.id, 'banner_color_template', color);
      if (locker.id === activeLockerId(cmd.profile)) {
        cmd.profile.setStat('banner_icon', icon);
        cmd.profile.setStat('banner_color', color);
      }
    },
    { profiles: ['athena', 'campaign'] },
  ),

  SetCosmeticLockerName: command(
    (cmd) => {
      const locker = cmd.profile.findItem(requireString(cmd.body, 'lockerItem', { max: 128 }));
      if (!locker) throw Errors.itemNotFound(cmd.body.lockerItem);
      cmd.profile.setItemAttr(locker.id, 'locker_name', requireString(cmd.body, 'name', { allowEmpty: true, max: 64 }));
    },
    { profiles: ['athena', 'campaign'] },
  ),

  CopyCosmeticLoadout: command(
    (cmd) => {
      const p = cmd.profile;
      const loadouts = [...(p.stat('loadouts') || [])];
      const source = requireInt(cmd.body, 'sourceIndex', { min: 0, max: 99 });
      const target = requireInt(cmd.body, 'targetIndex', { min: 0, max: 99 });
      const newName = optionalString(cmd.body, 'optNewNameForTarget');
      const src = loadouts[source] && p.items.get(loadouts[source]);
      if (!src) throw Errors.validation(`No loadout at index ${source}`);
      const attrs = deepClone(src.attributes);
      if (target >= loadouts.length || !loadouts[target]) {
        if (target > loadouts.length) throw Errors.validation(`targetIndex ${target} would leave a gap in the loadout list`);
        const id = guid();
        attrs.locker_name = newName;
        p.addItem(id, LOCKER_TEMPLATE, attrs);
        loadouts[target] = id;
        p.setStat('loadouts', loadouts);
      } else {
        const targetId = loadouts[target];
        p.setItemAttr(targetId, 'locker_slots_data', attrs.locker_slots_data);
        p.setItemAttr(targetId, 'banner_icon_template', attrs.banner_icon_template);
        p.setItemAttr(targetId, 'banner_color_template', attrs.banner_color_template);
        if (newName) p.setItemAttr(targetId, 'locker_name', newName);
      }
      if (target === p.stat('active_loadout_index', 0)) {
        mirrorLockerToFavorites(p, loadouts[target]);
        p.setStat('last_applied_loadout', loadouts[target]);
      }
    },
    { profiles: ['athena', 'campaign'] },
  ),

  DeleteCosmeticLoadout: command(
    (cmd) => {
      const p = cmd.profile;
      const loadouts = [...(p.stat('loadouts') || [])];
      const index = requireInt(cmd.body, 'index', { min: 1, max: 99 });
      const fallback = requireInt(cmd.body, 'fallbackLoadoutIndex', { min: -1, max: 99, fallback: 0 });
      if (!loadouts[index]) throw Errors.validation(`No loadout at index ${index}`);
      p.removeItem(loadouts[index]);
      if (cmd.body.leaveNullSlot) loadouts[index] = '';
      else loadouts.splice(index, 1);
      p.setStat('loadouts', loadouts);
      if (p.stat('active_loadout_index', 0) === index) {
        const next = fallback >= 0 && loadouts[fallback] ? fallback : 0;
        p.setStat('active_loadout_index', next);
        p.setStat('last_applied_loadout', loadouts[next]);
        mirrorLockerToFavorites(p, loadouts[next]);
      }
    },
    { profiles: ['athena', 'campaign'] },
  ),
};

function mirrorLockerToFavorites(profile, lockerId) {
  const locker = profile.items.get(lockerId);
  const slots = locker?.attributes?.locker_slots_data?.slots;
  if (!slots) return;
  const fallback = lockerSlotsFromStats(profile.stats);
  for (const slot of SLOT_NAMES) {
    const items = slots[slot]?.items || fallback[slot].items;
    const ids = items.map((t) => (t ? profile.findItem(t)?.id || '' : ''));
    profile.setStat(FAVORITE_STAT[slot], SLOT_SIZES[slot] ? ids : ids[0] || '');
  }
  if (locker.attributes.banner_icon_template) profile.setStat('banner_icon', locker.attributes.banner_icon_template);
  if (locker.attributes.banner_color_template) profile.setStat('banner_color', locker.attributes.banner_color_template);
}
