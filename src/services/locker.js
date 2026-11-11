import { Errors } from '../core/errors.js';
import { guid, isoNow, isPlainObject } from '../core/util.js';

// Locker Service slot templates -> athena favorite_* stats, so MCP readers (game servers using
// dedicated_server/QueryProfile) see the same outfit the Chapter 5+ client equipped.
const SLOT_TO_STAT = {
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_Character': ['favorite_character'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_Backpack': ['favorite_backpack'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_Pickaxe': ['favorite_pickaxe'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_Glider': ['favorite_glider'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_Contrails': ['favorite_skydivecontrail'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_LoadingScreen': ['favorite_loadingscreen'],
  'CosmeticLoadoutSlotTemplate:LoadoutSlot_LobbyMusic': ['favorite_musicpack'],
};

/**
 * Chapter 5+ Locker Service (/api/locker/v4/:deploymentId/account/:accountId/...).
 * The client owns the loadout format; Gallium validates the envelope, stores it per account,
 * echoes it back with server metadata, and mirrors the main slots into athena.
 */
export function createLockerService({ repos, profiles, log }) {
  const lLog = log.child('locker');

  function activeGroup(accountId, deploymentId) {
    const stored = repos.locker.get(accountId);
    const now = isoNow();
    const data = stored?.data || { athenaItemId: guid(), creationTime: now, loadouts: {} };
    return {
      deploymentId,
      accountId,
      athenaItemId: data.athenaItemId,
      creationTime: data.creationTime,
      updatedTime: stored?.updated || data.creationTime,
      loadouts: data.loadouts || {},
      shuffleType: data.shuffleType || 'DISABLED',
    };
  }

  function validateLoadouts(loadouts) {
    if (!isPlainObject(loadouts)) throw Errors.validation('loadouts must be an object keyed by loadout type');
    for (const [type, loadout] of Object.entries(loadouts)) {
      if (!type.startsWith('CosmeticLoadout:')) throw Errors.validation(`Unknown loadout type ${type}`);
      if (!isPlainObject(loadout) || (loadout.loadoutSlots !== undefined && !Array.isArray(loadout.loadoutSlots))) {
        throw Errors.validation(`Loadout ${type} must be an object with a loadoutSlots array`);
      }
    }
  }

  function mirrorToAthena(accountId, loadouts, build) {
    const slots = Object.values(loadouts).flatMap((l) => l.loadoutSlots || []);
    profiles.withProfiles(accountId, build, (get) => {
      const athena = get('athena');
      for (const slot of slots) {
        const stats = SLOT_TO_STAT[slot?.slotTemplate];
        if (!stats) continue;
        const item = typeof slot.equippedItemId === 'string' ? slot.equippedItemId : '';
        const owned = item ? athena.findItem(item) : null;
        for (const stat of stats) if (athena.stat(stat) !== (owned?.id ?? '')) athena.setStat(stat, owned?.id ?? '');
      }
    });
  }

  return {
    items(accountId, deploymentId) {
      return {
        activeLoadoutGroup: activeGroup(accountId, deploymentId),
        loadoutGroupPresets: repos.locker.presets(accountId, 'group'),
        loadoutPresets: repos.locker.presets(accountId, 'loadout'),
      };
    },
    putActiveGroup(accountId, deploymentId, body, build) {
      const loadouts = body?.loadouts;
      validateLoadouts(loadouts);
      const current = activeGroup(accountId, deploymentId);
      const data = { athenaItemId: current.athenaItemId, creationTime: current.creationTime, loadouts, shuffleType: typeof body.shuffleType === 'string' ? body.shuffleType : current.shuffleType };
      repos.locker.put(accountId, data, isoNow());
      try {
        mirrorToAthena(accountId, loadouts, build);
      } catch (err) {
        lLog.warn(`Could not mirror locker to athena for ${accountId}: ${err.message}`);
      }
      return activeGroup(accountId, deploymentId);
    },
    putPreset(accountId, deploymentId, kind, loadoutType, index, body) {
      if (!Number.isInteger(index) || index < 0 || index > 100) throw Errors.validation('Preset index must be 0-100');
      if (!isPlainObject(body)) throw Errors.validation('Preset body must be an object');
      if (kind === 'loadout' && !String(loadoutType).startsWith('CosmeticLoadout:')) throw Errors.validation(`Unknown loadout type ${loadoutType}`);
      const now = isoNow();
      const existing = repos.locker.presets(accountId, kind).find((p) => p.presetIndex === index && (kind === 'group' || p.loadoutType === loadoutType));
      const preset = {
        ...body,
        deploymentId,
        accountId,
        ...(kind === 'loadout' ? { loadoutType } : {}),
        presetIndex: index,
        presetId: existing?.presetId || guid(),
        creationTime: existing?.creationTime || now,
        updatedTime: now,
      };
      repos.locker.putPreset(accountId, kind, kind === 'loadout' ? loadoutType : '', index, preset);
      return preset;
    },
    deletePreset(accountId, kind, loadoutType, index) {
      if (!repos.locker.deletePreset(accountId, kind, kind === 'loadout' ? loadoutType : '', index)) throw Errors.notFound(`preset ${index}`);
    },
  };
}
