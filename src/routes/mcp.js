import { Errors } from '../core/errors.js';
import { requireAuth } from './middleware.js';

const ROUTES = ['client', 'public', 'dedicated_server'];

/** MCP profile commands: POST /fortnite/api/game/v2/profile/:accountId/:route/:command */
export function registerMcpRoutes(router) {
  router.post('/fortnite/api/game/v2/profile/:accountId/:route/:command', requireAuth, (ctx) => {
    const { accountId, route, command } = ctx.params;
    const routeName = route.toLowerCase();
    if (!ROUTES.includes(routeName)) throw Errors.notFound(`MCP route ${route}`);
    const { accounts, mcp } = ctx.services;

    if (routeName === 'client' && ctx.auth.accountId !== accountId) {
      throw Errors.missingPermission(`fortnite:profile:${accountId}:commands`);
    }
    // dedicated_server and public routes may be called by servers / other players.
    if (!ctx.auth.accountId && routeName === 'client') throw Errors.missingPermission(`fortnite:profile:${accountId}:commands`);
    const build = ctx.buildFor(accounts.require(accountId));

    const profileId = ctx.query.profileId || 'athena';
    const response = mcp.execute({
      accountId,
      route: routeName,
      command,
      profileId,
      rvn: ctx.query.rvn,
      body: ctx.body,
      build,
      query: ctx.query,
    });
    ctx.json(response);
  });
}
