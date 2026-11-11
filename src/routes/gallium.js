import { Errors } from '../core/errors.js';
import { requireAdmin, requireGameServer } from './middleware.js';

const VERSION = '1.0.0';

/** Gallium's own API: health, version-adapter inspection, game-server registration and admin. */
export function registerGalliumRoutes(router) {
  router.get('/gallium/api/health', (ctx) => {
    const s = ctx.services;
    ctx.json({
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      accounts: s.accounts.count(),
      xmppConnections: s.xmpp.connectionCount,
      parties: s.party.count,
      gameServers: s.gameServers.list().length,
      matchmakingQueue: s.matchmaking.queueLength(),
      cosmetics: s.cosmetics.count,
    });
  });

  router.get('/gallium/api/version', (ctx) => {
    const v = ctx.query.build ? ctx.services.versions.fromBuildString(ctx.query.build) : ctx.version;
    if (!v) throw Errors.validation(`Unrecognised build "${ctx.query.build}"`);
    ctx.json({ build: v.raw, detected: v.detected, season: v.season, chapter: v.chapter, adapter: v.adapter.id, adapterDescription: v.adapter.description, features: v.features, currencyProfile: v.adapter.currencyProfile });
  });

  // ---- game servers -------------------------------------------------------------------------
  const GS = '/gallium/api/gameservers';
  router.get(GS, requireGameServer, (ctx) => ctx.json(ctx.services.gameServers.list()));
  router.post(GS, requireGameServer, (ctx) => ctx.json(ctx.services.gameServers.view(ctx.services.gameServers.register(ctx.body)), 201));
  router.get(`${GS}/:id`, requireGameServer, (ctx) => ctx.json(ctx.services.gameServers.view(ctx.services.gameServers.get(ctx.params.id))));
  router.post(`${GS}/:id/heartbeat`, requireGameServer, (ctx) => ctx.json(ctx.services.gameServers.view(ctx.services.gameServers.heartbeat(ctx.params.id, ctx.body))));
  router.post(`${GS}/:id/reset`, requireGameServer, (ctx) => ctx.json(ctx.services.gameServers.view(ctx.services.gameServers.resetSession(ctx.params.id))));
  router.delete(`${GS}/:id`, requireGameServer, (ctx) => {
    if (!ctx.services.gameServers.remove(ctx.params.id)) throw Errors.notFound(`game server ${ctx.params.id}`);
    ctx.noContent();
  });
  /** Body: { players: [{ accountId, placement, kills, score, minutesPlayed, xp, playlist, questProgress: { objective: count } }] } */
  router.post(`${GS}/:id/results`, requireGameServer, (ctx) => {
    const server = ctx.services.gameServers.get(ctx.params.id);
    const players = ctx.body?.players;
    if (!Array.isArray(players) || !players.length || players.length > 200) throw Errors.validation('players must be a non-empty array (max 200)');
    const results = players.map((p) => {
      if (!p || typeof p.accountId !== 'string') throw Errors.validation('each player needs an accountId');
      const playlist = typeof p.playlist === 'string' ? p.playlist : server.playlists[0] || 'playlist_defaultsolo';
      return { accountId: p.accountId, ...ctx.services.admin.recordMatchResult(p.accountId, { ...p, playlist }) };
    });
    ctx.json({ results });
  });

  // ---- admin --------------------------------------------------------------------------------
  const A = '/gallium/api/admin/accounts';
  router.get(A, requireAdmin, (ctx) => ctx.json(ctx.services.accounts.list().map((a) => ({ id: a.id, displayName: a.displayName, email: a.email, lastLogin: a.lastLogin, lastBuild: a.lastBuild, banned: a.banned }))));
  router.post(A, requireAdmin, (ctx) => {
    const { email, displayName, password } = ctx.body || {};
    const a = ctx.services.admin.createAccount({ email, displayName, password });
    ctx.json({ id: a.id, displayName: a.displayName, email: a.email }, 201);
  });
  router.get(`${A}/:account`, requireAdmin, (ctx) => ctx.json(ctx.services.admin.describe(ctx.params.account)));
  router.delete(`${A}/:account`, requireAdmin, (ctx) => {
    ctx.services.admin.deleteAccount(ctx.params.account);
    ctx.noContent();
  });
  router.post(`${A}/:account/exchange`, requireAdmin, (ctx) => ctx.json(ctx.services.admin.exchangeCode(ctx.params.account)));
  router.post(`${A}/:account/items`, requireAdmin, (ctx) => {
    const ids = ctx.body?.templateIds;
    if (ids === 'all') return ctx.json({ granted: ctx.services.admin.grantAllCosmetics(ctx.params.account, ctx.body.build) });
    if (!Array.isArray(ids) || ids.some((t) => typeof t !== 'string' || !t.includes(':'))) throw Errors.validation('templateIds must be "all" or an array of "Type:Id" strings');
    ctx.json({ granted: ctx.services.admin.grantItems(ctx.params.account, ids, ctx.body.build) });
  });
  router.delete(`${A}/:account/items`, requireAdmin, (ctx) => {
    const ids = ctx.body?.templateIds;
    if (!Array.isArray(ids)) throw Errors.validation('templateIds must be an array');
    ctx.json({ removed: ctx.services.admin.revokeItems(ctx.params.account, ids, ctx.body.build) });
  });
  router.post(`${A}/:account/vbucks`, requireAdmin, (ctx) => {
    const { amount, add } = ctx.body || {};
    ctx.json({ vbucks: ctx.services.admin.setVbucks(ctx.params.account, amount, { add: !!add }) });
  });
  router.post(`${A}/:account/xp`, requireAdmin, (ctx) => ctx.json(ctx.services.admin.addXp(ctx.params.account, ctx.body?.amount, ctx.body?.build)));
  router.post(`${A}/:account/ban`, requireAdmin, (ctx) => {
    ctx.services.admin.setBanned(ctx.params.account, ctx.body?.banned !== false);
    ctx.noContent();
  });
}
