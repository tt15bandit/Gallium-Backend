import { Errors } from '../core/errors.js';
import { ownAccount } from './middleware.js';

/** Chapter 5+ Locker Service: /api/locker/v4/:deploymentId/account/:accountId/... */
export function registerLockerRoutes(router) {
  const base = '/api/locker/v4/:deploymentId/account/:accountId';

  router.get(`${base}/items`, ownAccount(), (ctx) => {
    ctx.json(ctx.services.locker.items(ctx.auth.accountId, ctx.params.deploymentId));
  });

  router.put(`${base}/active-loadout-group`, ownAccount(), (ctx) => {
    ctx.json(ctx.services.locker.putActiveGroup(ctx.auth.accountId, ctx.params.deploymentId, ctx.body, ctx.buildFor(ctx.auth.account)));
  });

  router.put(`${base}/loadout-presets/:loadoutType/:presetIndex`, ownAccount(), (ctx) => {
    const index = Number(ctx.params.presetIndex);
    ctx.json(ctx.services.locker.putPreset(ctx.auth.accountId, ctx.params.deploymentId, 'loadout', ctx.params.loadoutType, index, ctx.body));
  });

  router.delete(`${base}/loadout-presets/:loadoutType/:presetIndex`, ownAccount(), (ctx) => {
    ctx.services.locker.deletePreset(ctx.auth.accountId, 'loadout', ctx.params.loadoutType, Number(ctx.params.presetIndex));
    ctx.noContent();
  });

  router.put(`${base}/loadout-group-presets/:presetIndex`, ownAccount(), (ctx) => {
    const index = Number(ctx.params.presetIndex);
    if (!Number.isInteger(index)) throw Errors.validation('presetIndex must be an integer');
    ctx.json(ctx.services.locker.putPreset(ctx.auth.accountId, ctx.params.deploymentId, 'group', '', index, ctx.body));
  });

  router.delete(`${base}/loadout-group-presets/:presetIndex`, ownAccount(), (ctx) => {
    ctx.services.locker.deletePreset(ctx.auth.accountId, 'group', '', Number(ctx.params.presetIndex));
    ctx.noContent();
  });
}
