import { Errors } from '../../../core/errors.js';
import { command, requireArray, requireString, optionalString } from './helpers.js';

export const questCommands = {
  ClientQuestLogin: command(
    (cmd) => {
      cmd.services.quests.login(cmd.profile, cmd.build);
    },
    { profiles: ['athena', 'campaign', 'profile0'] },
  ),

  MarkNewQuestNotificationSent: command((cmd) => {
    for (const id of requireArray(cmd.body, 'itemIds', { of: 'string' })) {
      const entry = cmd.profile.findItem(id);
      if (entry && entry.item.attributes.sent_new_notification !== true) cmd.profile.setItemAttr(entry.id, 'sent_new_notification', true);
    }
  }),

  FortRerollDailyQuest: command(
    (cmd) => {
      cmd.services.quests.reroll(cmd.profile, requireString(cmd.body, 'questId', { max: 128 }), cmd.build);
    },
    { profiles: ['athena', 'campaign'] },
  ),

  // Client-tracked objectives (used by early builds): { advance: [{ statName, count }] }
  UpdateQuestClientObjectives: command((cmd) => {
    for (const a of requireArray(cmd.body, 'advance', { max: 100 })) {
      if (!a || typeof a.statName !== 'string' || !Number.isInteger(a.count) || a.count < 0) {
        throw Errors.validation('advance entries need a string statName and a non-negative integer count');
      }
      cmd.services.quests.progress(cmd.getProfile, cmd.profileId, a.statName, a.count, cmd.build);
    }
  }),

  AthenaPinQuest: command(
    (cmd) => {
      const id = optionalString(cmd.body, 'pinnedQuest');
      if (id && !cmd.profile.findItem(id)) throw Errors.itemNotFound(id);
      cmd.profile.setStat('pinned_quest', id);
    },
    { profiles: ['athena'] },
  ),

  SetPartyAssistQuest: command(
    (cmd) => {
      const id = optionalString(cmd.body, 'questToPinAsPartyAssist');
      if (id && !cmd.profile.findItem(id)) throw Errors.itemNotFound(id);
      cmd.profile.setStat('party_assist_quest', id);
    },
    { profiles: ['athena'] },
  ),
};
