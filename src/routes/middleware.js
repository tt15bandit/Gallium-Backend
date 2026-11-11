import { Errors } from '../core/errors.js';
import { safeEqual } from '../core/util.js';

function bearer(ctx) {
  const header = ctx.headers.authorization || '';
  const m = /^bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

/** Any valid access token (account or client_credentials). */
export function requireAuth(ctx) {
  const token = bearer(ctx);
  if (!token) throw Errors.authRequired(ctx.path);
  ctx.auth = ctx.services.auth.verify(token);
}

/** A valid access token that belongs to an account. */
export function requireAccount(ctx) {
  requireAuth(ctx);
  if (!ctx.auth.accountId) throw Errors.missingPermission('account', 'READ');
}

/** The :param account id in the path must be the caller's own account. */
export function ownAccount(param = 'accountId') {
  return function ownAccountCheck(ctx) {
    requireAccount(ctx);
    if (ctx.params[param] !== ctx.auth.accountId) throw Errors.missingPermission(`fortnite:profile:${ctx.params[param]}:commands`);
  };
}

function keyAuth(ctx, configuredKey, label) {
  if (configuredKey) {
    const token = bearer(ctx);
    if (token && safeEqual(token, configuredKey)) return;
    throw Errors.missingPermission(label);
  }
  if (!ctx.isLoopback) throw Errors.missingPermission(`${label} (set an API key to allow remote callers)`);
}

export function requireGameServer(ctx) {
  keyAuth(ctx, ctx.services.config.gameServers.apiKey, 'gallium:gameservers');
}

export function requireAdmin(ctx) {
  keyAuth(ctx, ctx.services.config.admin.apiKey, 'gallium:admin');
}
