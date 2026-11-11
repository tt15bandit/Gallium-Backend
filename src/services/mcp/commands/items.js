import { Errors } from '../../../core/errors.js';
import { command, requireArray, requireBool, requireString } from './helpers.js';

export const itemCommands = {
  MarkItemSeen: command((cmd) => {
    const ids = requireArray(cmd.body, 'itemIds', { of: 'string' });
    for (const id of ids) {
      const entry = cmd.profile.findItem(id);
      // Clients mark items they were shown; ids filtered out for this build are skipped silently.
      if (entry && entry.item.attributes.item_seen !== true) cmd.profile.setItemAttr(entry.id, 'item_seen', true);
    }
  }),

  SetItemFavoriteStatus: command((cmd) => {
    const id = requireString(cmd.body, 'targetItemId', { max: 256 });
    const fav = requireBool(cmd.body, 'bFavorite');
    const entry = cmd.profile.findItem(id);
    if (!entry) throw Errors.itemNotFound(id);
    cmd.profile.setItemAttr(entry.id, 'favorite', fav);
  }),

  SetItemFavoriteStatusBatch: command((cmd) => {
    const ids = requireArray(cmd.body, 'itemIds', { of: 'string' });
    const status = requireArray(cmd.body, 'itemFavStatus');
    if (status.length !== ids.length || status.some((s) => typeof s !== 'boolean')) {
      throw Errors.validation('itemFavStatus must be a boolean array the same length as itemIds');
    }
    ids.forEach((id, i) => {
      const entry = cmd.profile.findItem(id);
      if (!entry) throw Errors.itemNotFound(id);
      cmd.profile.setItemAttr(entry.id, 'favorite', status[i]);
    });
  }),

  SetItemArchivedStatusBatch: command((cmd) => {
    const ids = requireArray(cmd.body, 'itemIds', { of: 'string' });
    const archived = requireBool(cmd.body, 'archived');
    for (const id of ids) {
      const entry = cmd.profile.findItem(id);
      if (!entry) throw Errors.itemNotFound(id);
      cmd.profile.setItemAttr(entry.id, 'archived', archived);
    }
  }),
};
