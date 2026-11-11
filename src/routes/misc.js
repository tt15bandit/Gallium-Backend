import fs from 'node:fs';
import path from 'node:path';
import { isoNow } from '../core/util.js';
import { defaultNewsImage } from '../services/images.js';
import { ownAccount, requireAccount, requireAuth } from './middleware.js';

/** Small Epic services the client checks during login (lightswitch, EULA, events, ...). */
export function registerMiscRoutes(router) {
  const lightswitch = (ctx) => ({
    serviceInstanceId: 'fortnite',
    status: 'UP',
    message: 'Fortnite is online',
    maintenanceUri: null,
    overrideCatalogIds: ['a7f138b2e51945ffbfdacc1af0541053'],
    allowedActions: ['PLAY', 'DOWNLOAD'],
    banned: !!ctx.services.auth.tryVerify((ctx.headers.authorization || '').replace(/^bearer\s+/i, ''))?.account?.banned,
    launcherInfoDTO: { appName: 'Fortnite', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', namespace: 'fn' },
  });
  router.get('/lightswitch/api/service/bulk/status', (ctx) => ctx.json([lightswitch(ctx)]));
  router.get('/lightswitch/api/service/:serviceId/status', (ctx) => ctx.json(lightswitch(ctx)));

  router.get('/waitingroom/api/waitingroom', (ctx) => ctx.noContent());
  router.post('/datarouter/api/v1/public/data', (ctx) => ctx.noContent());
  router.post('/datarouter/api/v1/public/data/*', (ctx) => ctx.noContent());

  const assetBase = (ctx) => `http://${ctx.localHost}:${ctx.localPort}`;
  router.get('/content/api/pages/fortnite-game', (ctx) => ctx.json(ctx.services.content.pages(ctx.version, { assetBase: assetBase(ctx) })));
  router.get('/content/api/pages/fortnite-game/:section', (ctx) => {
    const pages = ctx.services.content.pages(ctx.version, { assetBase: assetBase(ctx) });
    const section = Object.entries(pages).find(([k]) => k.toLowerCase() === ctx.params.section.toLowerCase());
    if (section) ctx.json(section[1]);
    else ctx.json({ _title: ctx.params.section, _activeDate: '2017-07-25T00:00:00.000Z', lastModified: isoNow(), _locale: 'en-US' });
  });

  router.get('/eulatracking/api/shared/agreements/fn', (ctx) => ctx.noContent());
  router.get('/eulatracking/api/public/agreements/fn/account/:accountId', ownAccount(), (ctx) => ctx.noContent());

  router.get('/socialban/api/public/v1/:accountId', ownAccount(), (ctx) => ctx.json({ bans: [], warnings: [] }));

  router.get('/api/v1/events/Fortnite/download/:accountId', ownAccount(), (ctx) =>
    ctx.json({
      player: { gameId: 'Fortnite', accountId: ctx.auth.accountId, tokens: [], teams: {}, pendingPayouts: [], pendingPenalties: {}, persistentScores: {}, groupIdentity: {} },
      events: [],
      templates: [],
      scores: [],
    }),
  );
  router.post('/api/v1/players/Fortnite/tokens', requireAuth, (ctx) => {
    const ids = Array.isArray(ctx.body?.accountIds) ? ctx.body.accountIds.filter((x) => typeof x === 'string').slice(0, 100) : [];
    ctx.json({ accounts: ids.map((accountId) => ({ accountId, tokens: [] })) });
  });

  router.patch('/presence/api/v1/_/:accountId/settings/subscriptions', ownAccount(), (ctx) => ctx.noContent());
  router.get('/presence/api/v1/_/:accountId/last-online', ownAccount(), (ctx) => ctx.json({}));

  // Creative discovery asset directory (Chapter 2+ frontends request it after login).
  router.post('/api/v1/assets/Fortnite/:version/:netcl', requireAuth, (ctx) => ctx.json({ FortCreativeDiscoverySurface: { meta: { promotion: 0 }, assets: {} } }));
  router.get('/api/v1/assets/Fortnite/:version/:netcl', requireAuth, (ctx) => ctx.json({ FortCreativeDiscoverySurface: { meta: { promotion: 0 }, assets: {} } }));

  router.get('/fortnite/api/game/v2/twitch/:accountId', requireAccount, (ctx) => ctx.noContent());

  // News image: data/content/news.png if you add one, otherwise a generated default.
  router.get('/gallium/assets/news.png', (ctx) => {
    const own = path.join(ctx.services.config.data.dir, 'content', 'news.png');
    ctx.header('Cache-Control', 'max-age=3600');
    ctx.send(fs.existsSync(own) ? fs.readFileSync(own) : defaultNewsImage(), 'image/png');
  });

  // Global chat rooms (1.x frontends). Field names from the 1.8 client; the room is an XMPP MUC
  // hosted by Gallium, so everyone on this backend shares one global chat.
  router.get('/fortnite/api/game/v2/chat/:accountId/recommendGeneralChatRooms/:subgame/:platform', ownAccount(), (ctx) =>
    ctx.json({
      globalChatRooms: [{ roomName: 'fortnite' }],
      founderChatRooms: [],
      bNeedsPaidAccessForGlobalChat: false,
      bNeedsPaidAccessForFounderChat: false,
      bIsGlobalChatDisabled: false,
      bIsFounderChatDisabled: false,
      bIsSubGameGlobalChatDisabled: false,
    }),
  );
}
