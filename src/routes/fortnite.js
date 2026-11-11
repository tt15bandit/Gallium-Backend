import { Errors } from '../core/errors.js';
import { isoNow } from '../core/util.js';
import { ownAccount, requireAccount, requireAuth } from './middleware.js';

/** fortnite-public-service routes other than MCP. */
export function registerFortniteRoutes(router) {
  // ---- version / access checks --------------------------------------------------------------
  router.get('/fortnite/api/version', (ctx) =>
    ctx.json({ app: 'fortnite', serverDate: isoNow(), overridePropertiesVersion: 'unknown', cln: String(ctx.version.cl), build: String(ctx.version.cl), moduleName: 'Fortnite-Core', buildDate: isoNow(), version: ctx.version.branch, branch: `Release-${ctx.version.branch}`, modules: {} }),
  );
  router.get('/fortnite/api/versioncheck', (ctx) => ctx.json({ type: 'NO_UPDATE' }));
  router.get('/fortnite/api/versioncheck/*', (ctx) => ctx.json({ type: 'NO_UPDATE' }));
  router.get('/fortnite/api/v2/versioncheck', (ctx) => ctx.json({ type: 'NO_UPDATE' }));
  router.get('/fortnite/api/v2/versioncheck/*', (ctx) => ctx.json({ type: 'NO_UPDATE' }));
  router.get('/fortnite/api/game/v2/enabled_features', requireAuth, (ctx) => ctx.json([]));
  router.post('/fortnite/api/game/v2/tryPlayOnPlatform/account/:accountId', ownAccount(), (ctx) => ctx.text('true'));
  router.post('/fortnite/api/game/v2/grant_access/:accountId', ownAccount(), (ctx) => ctx.noContent());
  router.post('/fortnite/api/game/v2/profileToken/verify/:accountId', ownAccount(), (ctx) => ctx.noContent());
  router.post('/fortnite/api/storeaccess/v1/request_access/:accountId', ownAccount(), (ctx) => ctx.noContent());
  router.get('/fortnite/api/receipts/v1/account/:accountId/receipts', ownAccount(), (ctx) => ctx.json([]));
  router.get('/fortnite/api/game/v2/world/info', requireAuth, (ctx) => ctx.json({ theaters: [], missions: [], missionAlerts: [] }));
  router.get('/fortnite/api/game/v2/friendcodes/:accountId/:platform', ownAccount(), (ctx) => ctx.json([]));
  router.get('/fortnite/api/game/v2/br-inventory/account/:accountId', ownAccount(), (ctx) => ctx.json({ stash: { globalcash: 0 } }));
  router.post('/fortnite/api/feedback/*', requireAuth, (ctx) => ctx.noContent());

  router.get('/fortnite/api/game/v2/privacy/account/:accountId', ownAccount(), (ctx) => {
    const athena = ctx.services.profiles.withProfiles(ctx.auth.accountId, ctx.buildFor(ctx.auth.account), (get) => get('athena'));
    ctx.json({ accountId: ctx.auth.accountId, optOutOfPublicLeaderboards: athena.stat('optOutOfPublicLeaderboards', false) === true });
  });
  router.post('/fortnite/api/game/v2/privacy/account/:accountId', ownAccount(), (ctx) => {
    const value = ctx.body?.optOutOfPublicLeaderboards;
    if (typeof value !== 'boolean') throw Errors.validation('optOutOfPublicLeaderboards must be a boolean');
    ctx.services.profiles.withProfiles(ctx.auth.accountId, ctx.buildFor(ctx.auth.account), (get) => get('athena').setStat('optOutOfPublicLeaderboards', value));
    ctx.json({ accountId: ctx.auth.accountId, optOutOfPublicLeaderboards: value });
  });

  // ---- storefront ---------------------------------------------------------------------------
  router.get('/fortnite/api/storefront/v2/catalog', requireAuth, (ctx) => ctx.json(ctx.services.catalog.get(ctx.version)));
  router.get('/fortnite/api/storefront/v2/keychain', requireAuth, (ctx) => ctx.json([]));
  router.get('/fortnite/api/storefront/v2/gift/check_eligibility/recipient/:recipientId/offer/:offerId', requireAccount, (ctx) => {
    const { catalog, friends, accounts } = ctx.services;
    const { recipientId, offerId } = ctx.params;
    accounts.require(recipientId);
    const offer = catalog.findOffer(offerId, ctx.version);
    if (!offer || offer.battlePass) throw Errors.offerNotFound(offerId);
    if (!friends.areFriends(ctx.auth.accountId, recipientId)) throw Errors.giftsDisabled(recipientId);
    ctx.json({ price: offer.entry.prices[0], items: offer.entry.itemGrants });
  });
  router.get('/catalog/api/shared/bulk/offers', requireAuth, (ctx) => ctx.json({}));
  router.post('/priceengine/api/shared/offers/price', requireAuth, (ctx) => ctx.json({}));

  // ---- calendar -----------------------------------------------------------------------------
  router.get('/fortnite/api/calendar/v1/timeline', requireAuth, (ctx) => ctx.json(ctx.services.content.timeline(ctx.version)));

  // ---- cloud storage ------------------------------------------------------------------------
  router.get('/fortnite/api/cloudstorage/system', requireAuth, (ctx) => ctx.json(ctx.services.cloudStorage.listSystem(ctx.version)));
  // No v2 dispatch config: 32.00 logs show a 204 here makes the client use the legacy (v1) file system.
  router.get('/fortnite/api/cloudstorage/system/config', requireAuth, (ctx) => ctx.noContent());
  router.get('/fortnite/api/cloudstorage/system/:filename', requireAuth, (ctx) => {
    ctx.send(ctx.services.cloudStorage.readSystem(ctx.version, ctx.params.filename), 'application/octet-stream');
  });
  // Empty config makes builds that ask for user-cloud config fall back to the legacy (v1) system.
  router.get('/fortnite/api/cloudstorage/user/config', requireAuth, (ctx) => ctx.noContent());
  router.get('/fortnite/api/cloudstorage/user/:accountId', ownAccount(), (ctx) => ctx.json(ctx.services.cloudStorage.listUser(ctx.auth.accountId)));
  router.get('/fortnite/api/cloudstorage/user/:accountId/:filename', ownAccount(), (ctx) => {
    ctx.send(ctx.services.cloudStorage.readUser(ctx.auth.accountId, ctx.params.filename), 'application/octet-stream');
  });
  router.put('/fortnite/api/cloudstorage/user/:accountId/:filename', ownAccount(), (ctx) => {
    ctx.services.cloudStorage.writeUser(ctx.auth.accountId, ctx.params.filename, ctx.rawBody);
    ctx.noContent();
  });
  router.delete('/fortnite/api/cloudstorage/user/:accountId/:filename', ownAccount(), (ctx) => {
    ctx.services.cloudStorage.deleteUser(ctx.auth.accountId, ctx.params.filename);
    ctx.noContent();
  });

  // ---- matchmaking --------------------------------------------------------------------------
  router.get('/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId', ownAccount(), (ctx) => {
    ctx.json(ctx.services.matchmaking.createTicket(ctx.auth.accountId, ctx.query));
  });
  router.get('/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId', ownAccount(), (ctx) => {
    ctx.json({ accountId: ctx.auth.accountId, sessionId: ctx.params.sessionId, key: ctx.params.sessionId });
  });
  router.get('/fortnite/api/matchmaking/session/findPlayer/:accountId', requireAuth, (ctx) => ctx.json([]));
  router.post('/fortnite/api/matchmaking/session/matchMakingRequest', requireAuth, (ctx) => ctx.json([]));
  router.get('/fortnite/api/matchmaking/session/:sessionId', requireAuth, (ctx) => ctx.json(ctx.services.matchmaking.sessionView(ctx.params.sessionId)));
  router.post('/fortnite/api/matchmaking/session/:sessionId/join', requireAccount, (ctx) => {
    ctx.services.matchmaking.joinSession(ctx.params.sessionId, ctx.auth.accountId);
    ctx.noContent();
  });

  // ---- stats --------------------------------------------------------------------------------
  router.get('/fortnite/api/statsv2/account/:accountId', requireAuth, (ctx) => ctx.json(ctx.services.stats.statsV2(ctx.services.accounts.require(ctx.params.accountId).id)));
  router.get('/statsproxy/api/statsv2/account/:accountId', requireAuth, (ctx) => ctx.json(ctx.services.stats.statsV2(ctx.services.accounts.require(ctx.params.accountId).id)));
  router.get('/fortnite/api/stats/accountId/:accountId/bulk/window/alltime', requireAuth, (ctx) => ctx.json(ctx.services.stats.legacyBulk(ctx.services.accounts.require(ctx.params.accountId).id)));
  router.post('/fortnite/api/leaderboards/type/global/stat/:stat/window/:window', requireAuth, (ctx) => ctx.json({ statName: ctx.params.stat, statWindow: ctx.params.window, entries: [] }));
  router.get('/fortnite/api/game/v2/leaderboards/cohort/:accountId', ownAccount(), (ctx) => ctx.json({ accountId: ctx.auth.accountId, cohortAccounts: [], expiresAt: '9999-12-31T00:00:00.000Z', playlist: ctx.query.playlist || '' }));

  // ---- creative (lists only; islands are not hosted) ----------------------------------------
  router.get('/fortnite/api/game/v2/creative/favorites/:accountId', ownAccount(), (ctx) => ctx.json({ results: [], hasMore: false }));
  router.get('/fortnite/api/game/v2/creative/history/:accountId', ownAccount(), (ctx) => ctx.json({ results: [], hasMore: false }));
}
