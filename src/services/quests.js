import { Errors } from '../core/errors.js';
import { guid, isoNow, startOfUtcDay } from '../core/util.js';
import { grantItem } from './profiles/grants.js';

/**
 * Daily / weekly quests. Quest definitions are game data, so they are read from
 * data/quests/season<N>.json (falling back to data/quests/default.json):
 *
 * {
 *   "maxDaily": 3,
 *   "daily":  [{ "templateId": "Quest:...", "objectives": [{ "name": "...", "count": 3 }],
 *                "rewards": { "xp": 500, "items": [{ "templateId": "...", "quantity": 1 }] } }],
 *   "weekly": [ ...same shape... ]
 * }
 *
 * Objective progress is reported by game servers (POST /gallium/api/gameservers/:id/results)
 * or by clients that track objectives themselves (UpdateQuestClientObjectives).
 */
export function createQuestService({ dataFiles, progression, cosmetics, log }) {
  const qLog = log.child('quests');

  function pool(season) {
    const p = dataFiles.first(`quests/season${season}.json`, 'quests/default.json') || {};
    const valid = (q) => q && typeof q.templateId === 'string' && Array.isArray(q.objectives) && q.objectives.length > 0;
    return { maxDaily: Number.isInteger(p.maxDaily) ? p.maxDaily : 3, daily: (p.daily || []).filter(valid), weekly: (p.weekly || []).filter(valid) };
  }

  function activeQuests(profile, kind = null) {
    return profile.itemsOfType('Quest').filter(({ item }) => item.attributes.quest_state === 'Active' && (!kind || item.attributes.gallium_kind === kind));
  }

  function addQuest(profile, def, kind, build) {
    const now = isoNow();
    const objectives = def.objectives.map((o) => (typeof o === 'string' ? { name: o, count: 1 } : { name: o.name, count: o.count || 1 }));
    const attrs = {
      creation_time: now,
      level: -1,
      item_seen: false,
      playlists: [],
      sent_new_notification: false,
      challenge_bundle_id: '',
      xp_reward_scalar: 1,
      challenge_linked_quest_given: '',
      quest_pool: '',
      quest_state: 'Active',
      bucket: '',
      last_state_change_time: now,
      challenge_linked_quest_parent: '',
      max_level_bonus: 0,
      xp: 0,
      quest_rarity: 'uncommon',
      favorite: false,
      gallium_kind: kind,
      gallium_season: build.season,
      gallium_objectives: Object.fromEntries(objectives.map((o) => [o.name, o.count])),
    };
    for (const o of objectives) attrs[`completion_${o.name}`] = 0;
    const id = guid();
    profile.addItem(id, def.templateId, attrs, 1);
    return id;
  }

  function pickNew(profile, defs, count) {
    const taken = new Set(profile.itemsOfType('Quest').map(({ item }) => item.templateId.toLowerCase()));
    const candidates = defs.filter((d) => !taken.has(d.templateId.toLowerCase()));
    const out = [];
    while (out.length < count && candidates.length) out.push(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]);
    return out;
  }

  /** ClientQuestLogin: hand out today's dailies and any missing weeklies. */
  function login(profile, build) {
    const { daily, weekly, maxDaily } = pool(build.season);
    const qm = { dailyLoginInterval: '0001-01-01T00:00:00.000Z', dailyQuestRerolls: 1, ...(profile.stat('quest_manager') || {}) };
    const today = startOfUtcDay().toISOString();
    if (qm.dailyLoginInterval < today) {
      const missing = Math.max(0, maxDaily - activeQuests(profile, 'daily').length);
      for (const def of pickNew(profile, daily, missing)) addQuest(profile, def, 'daily', build);
      profile.setStat('quest_manager', { ...qm, dailyLoginInterval: isoNow(), dailyQuestRerolls: 1 });
    }
    const owned = new Set(profile.itemsOfType('Quest').map(({ item }) => item.templateId.toLowerCase()));
    for (const def of weekly) if (!owned.has(def.templateId.toLowerCase())) addQuest(profile, def, 'weekly', build);
  }

  function reroll(profile, questId, build) {
    const entry = profile.findItem(questId);
    if (!entry || !entry.item.templateId.toLowerCase().startsWith('quest:')) throw Errors.itemNotFound(questId);
    if (entry.item.attributes.gallium_kind !== 'daily' || entry.item.attributes.quest_state !== 'Active') throw Errors.invalidParameter('Only active daily quests can be rerolled');
    const qm = { ...(profile.stat('quest_manager') || {}) };
    if (!(qm.dailyQuestRerolls > 0)) throw Errors.invalidParameter('No daily quest rerolls left');
    const [replacement] = pickNew(profile, pool(build.season).daily, 1);
    if (!replacement) throw Errors.invalidParameter('No other daily quests are available');
    profile.removeItem(entry.id);
    addQuest(profile, replacement, 'daily', build);
    profile.setStat('quest_manager', { ...qm, dailyQuestRerolls: qm.dailyQuestRerolls - 1 });
  }

  /**
   * Advance an objective on every active quest in `profileId` that tracks it, completing
   * quests (and granting their rewards) when all objectives reach their target.
   */
  function progress(getProfile, profileId, objective, count, build) {
    const profile = getProfile(profileId);
    const key = `completion_${objective}`;
    const completed = [];
    for (const { id, item } of activeQuests(profile)) {
      if (!(key in item.attributes)) continue;
      const target = item.attributes.gallium_objectives?.[objective] ?? Infinity;
      const next = Math.min(target, (item.attributes[key] || 0) + count);
      if (next === item.attributes[key]) continue;
      profile.setItemAttr(id, key, next);
      const goals = item.attributes.gallium_objectives || {};
      const done = Object.entries(goals).every(([name, need]) => (item.attributes[`completion_${name}`] || 0) >= need);
      if (done) {
        profile.setItemAttr(id, 'quest_state', 'Claimed');
        profile.setItemAttr(id, 'last_state_change_time', isoNow());
        completed.push(item.templateId);
        grantRewards(getProfile, item.templateId, build);
      }
    }
    if (completed.length) qLog.debug(`${profile.accountId} completed ${completed.join(', ')}`);
    return completed;
  }

  function grantRewards(getProfile, templateId, build) {
    const p = pool(build.season);
    const def = [...p.daily, ...p.weekly].find((d) => d.templateId.toLowerCase() === templateId.toLowerCase());
    if (!def?.rewards) return;
    if (Number.isInteger(def.rewards.xp) && def.rewards.xp > 0) progression.grantXp(getProfile, def.rewards.xp, build);
    for (const g of def.rewards.items || []) if (g?.templateId) grantItem(getProfile, g.templateId, g.quantity || 1, cosmetics);
  }

  return { login, reroll, progress, pool };
}
