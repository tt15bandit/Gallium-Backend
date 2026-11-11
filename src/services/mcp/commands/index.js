import { accountCommands } from './account.js';
import { itemCommands } from './items.js';
import { lockerCommands } from './locker.js';
import { purchaseCommands } from './purchases.js';
import { questCommands } from './quests.js';

/** MCP commands shared by every build. Version adapters can add or override entries. */
export const coreCommands = Object.freeze({
  ...accountCommands,
  ...itemCommands,
  ...lockerCommands,
  ...purchaseCommands,
  ...questCommands,
});
