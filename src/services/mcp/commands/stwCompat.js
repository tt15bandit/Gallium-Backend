import { command } from './helpers.js';

/**
 * Save the World is not implemented. Builds up to Chapter 1 still fire these STW commands
 * during the BR login flow (observed in 1.x, 3.1 and 4.5 traffic); answering them with the
 * unchanged profile keeps the frontend from erroring. They are registered only by the
 * adapters for those builds.
 */
const unchanged = (profiles) => command(() => {}, { profiles });

export const stwCompatCommands = {
  RefreshExpeditions: unchanged(['campaign', 'profile0']),
  IssueFriendCode: unchanged(['profile0', 'common_core']),
  SetHardcoreModifier: unchanged(['campaign', 'profile0']),
};
