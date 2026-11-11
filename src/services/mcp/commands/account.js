import { Errors } from '../../../core/errors.js';
import { isoNow } from '../../../core/util.js';
import { command, requireBool, requireString } from './helpers.js';
import { cosmeticAttributes } from '../../profiles/templates.js';

const MTX_PLATFORMS = ['EpicPC', 'EpicPCKorea', 'Epic', 'EpicAndroid', 'PSN', 'Live', 'XboxOneGDK', 'Nintendo', 'IOSAppStore', 'GooglePlay', 'Samsung', 'WeGame', 'Shared'];
const MFA_REWARD = 'AthenaDance:EID_BoogieDown';

export const accountCommands = {
  QueryProfile: command(() => {}, { routes: ['client', 'dedicated_server'] }),

  QueryPublicProfile: command(() => {}, { routes: ['public', 'client'], profiles: ['common_public', 'campaign'] }),

  // Called by early builds at login; the response's serverTime is what the client needs.
  GetMcpTimeForLogin: command(() => {}),

  IncrementNamedCounterStat: command((cmd) => {
    const name = requireString(cmd.body, 'counterName', { max: 128 });
    const counters = { ...(cmd.profile.stat('named_counters') || {}) };
    const prev = counters[name] || { current_count: 0 };
    counters[name] = { current_count: (prev.current_count || 0) + 1, last_incremented_time: isoNow() };
    cmd.profile.setStat('named_counters', counters);
  }),

  ClaimMfaEnabled: command(
    (cmd) => {
      const core = cmd.profile;
      if (core.stat('mfa_reward_claimed') === true || !cmd.services.config.accounts.grantMfaReward) return;
      const athena = cmd.getProfile('athena');
      if (!athena.findItem(MFA_REWARD)) athena.addItem(MFA_REWARD, MFA_REWARD, cosmeticAttributes());
      core.setStat('mfa_reward_claimed', true);
    },
    { profiles: ['common_core'] },
  ),

  SetMtxPlatform: command(
    (cmd) => {
      const platform = requireString(cmd.body, 'newPlatform', { max: 32 });
      if (!MTX_PLATFORMS.includes(platform)) throw Errors.validation(`Unknown MTX platform ${platform}`);
      if (cmd.profile.stat('current_mtx_platform') !== platform) cmd.profile.setStat('current_mtx_platform', platform);
    },
    { profiles: ['common_core', 'profile0'] },
  ),

  SetReceiveGiftsEnabled: command(
    (cmd) => {
      cmd.profile.setStat('allowed_to_receive_gifts', requireBool(cmd.body, 'bReceiveGifts'));
    },
    { profiles: ['common_core'] },
  ),

  SetAffiliateName: command(
    (cmd) => {
      const name = requireString(cmd.body, 'affiliateName', { allowEmpty: true, max: 32 });
      if (name && !/^[A-Za-z0-9_\-. ]+$/.test(name)) throw Errors.validation('affiliateName contains invalid characters');
      cmd.profile.setStat('mtx_affiliate', name);
      cmd.profile.setStat('mtx_affiliate_set_time', name ? isoNow() : '');
    },
    { profiles: ['common_core'] },
  ),

  // Store purchases are fulfilled the moment the checkout page completes, so nothing is pending.
  RedeemRealMoneyPurchases: command(() => {}, { profiles: ['common_core', 'profile0'] }),

  /**
   * Sent after the purchase browser reports a receipt. Gallium already granted the V-Bucks when
   * the checkout page completed, so this only confirms the receipt (no double grant) and lets the
   * response carry the updated balance. The payload is logged to keep the format visible.
   */
  VerifyRealMoneyPurchase: command(
    (cmd) => {
      const core = cmd.getProfile('common_core');
      const known = cmd.services.vbucksStore.isFulfilled(core, cmd.body);
      cmd.log.info(`VerifyRealMoneyPurchase from ${cmd.accountId}: ${known ? 'known Gallium receipt' : 'unknown receipt'} ${JSON.stringify(cmd.body).slice(0, 500)}`);
      cmd.forceFullProfile();
    },
    { profiles: ['common_core', 'profile0'] },
  ),

  SetBattleRoyaleBanner: command(
    (cmd) => {
      const icon = requireString(cmd.body, 'homebaseBannerIconId', { max: 128 });
      const color = requireString(cmd.body, 'homebaseBannerColorId', { max: 128 });
      cmd.profile.setStat('banner_icon', icon);
      cmd.profile.setStat('banner_color', color);
    },
    { profiles: ['athena'] },
  ),

  SetRandomCosmeticLoadoutFlag: command(
    (cmd) => {
      cmd.profile.setStat('use_random_loadout', requireBool(cmd.body, 'random'));
    },
    { profiles: ['athena'] },
  ),
};
