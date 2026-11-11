import { Errors } from '../core/errors.js';
import { ownAccount, requireAccount } from './middleware.js';

/** friends-public-service (legacy "public" and v1 APIs) and party-service v1. */
export function registerSocialRoutes(router) {
  // ---- friends: legacy API ------------------------------------------------------------------
  router.get('/friends/api/public/friends/:accountId', ownAccount(), (ctx) => {
    ctx.json(ctx.services.friends.legacyList(ctx.auth.accountId, ctx.query.includePending === 'true'));
  });
  router.post('/friends/api/public/friends/:accountId/:friendId', ownAccount(), (ctx) => {
    ctx.services.friends.request(ctx.auth.accountId, ctx.params.friendId);
    ctx.noContent();
  });
  router.delete('/friends/api/public/friends/:accountId/:friendId', ownAccount(), (ctx) => {
    ctx.services.friends.remove(ctx.auth.accountId, ctx.params.friendId);
    ctx.noContent();
  });
  router.get('/friends/api/public/blocklist/:accountId', ownAccount(), (ctx) => {
    ctx.json({ blockedUsers: ctx.services.friends.blocklist(ctx.auth.accountId).map((b) => b.accountId) });
  });
  router.post('/friends/api/public/blocklist/:accountId/:blockedId', ownAccount(), (ctx) => {
    ctx.services.friends.block(ctx.auth.accountId, ctx.params.blockedId);
    ctx.noContent();
  });
  router.delete('/friends/api/public/blocklist/:accountId/:blockedId', ownAccount(), (ctx) => {
    ctx.services.friends.unblock(ctx.auth.accountId, ctx.params.blockedId);
    ctx.noContent();
  });
  router.get('/friends/api/public/list/fortnite/:accountId/recentPlayers', ownAccount(), (ctx) => ctx.json([]));
  router.get('/friends/api/public/settings/:accountId', ownAccount(), (ctx) => ctx.json({ acceptInvites: 'public' }));

  // ---- friends: v1 API ----------------------------------------------------------------------
  router.get('/friends/api/v1/:accountId/summary', ownAccount(), (ctx) => ctx.json(ctx.services.friends.summary(ctx.auth.accountId)));
  router.get('/friends/api/v1/:accountId/friends', ownAccount(), (ctx) => ctx.json(ctx.services.friends.summary(ctx.auth.accountId).friends));
  router.get('/friends/api/v1/:accountId/incoming', ownAccount(), (ctx) => ctx.json(ctx.services.friends.summary(ctx.auth.accountId).incoming));
  router.get('/friends/api/v1/:accountId/outgoing', ownAccount(), (ctx) => ctx.json(ctx.services.friends.summary(ctx.auth.accountId).outgoing));
  router.get('/friends/api/v1/:accountId/suggested', ownAccount(), (ctx) => ctx.json([]));
  router.get('/friends/api/v1/:accountId/blocklist', ownAccount(), (ctx) => ctx.json(ctx.services.friends.summary(ctx.auth.accountId).blocklist));
  router.get('/friends/api/v1/:accountId/settings', ownAccount(), (ctx) => ctx.json({ acceptInvites: 'public', mutualPrivacy: 'ALL' }));
  router.put('/friends/api/v1/:accountId/settings', ownAccount(), (ctx) => ctx.json({ acceptInvites: 'public', mutualPrivacy: 'ALL', ...(ctx.body || {}) }));
  router.get('/friends/api/v1/:accountId/recent/fortnite', ownAccount(), (ctx) => ctx.json([]));
  router.post('/friends/api/v1/:accountId/friends/:friendId', ownAccount(), (ctx) => {
    ctx.services.friends.request(ctx.auth.accountId, ctx.params.friendId);
    ctx.noContent();
  });
  router.delete('/friends/api/v1/:accountId/friends/:friendId', ownAccount(), (ctx) => {
    ctx.services.friends.remove(ctx.auth.accountId, ctx.params.friendId);
    ctx.noContent();
  });
  router.put('/friends/api/v1/:accountId/friends/:friendId/alias', ownAccount(), (ctx) => {
    const alias = ctx.rawBody.toString('utf8').trim().slice(0, 32);
    ctx.services.friends.setAlias(ctx.auth.accountId, ctx.params.friendId, alias);
    ctx.noContent();
  });
  router.delete('/friends/api/v1/:accountId/friends/:friendId/alias', ownAccount(), (ctx) => {
    ctx.services.friends.setAlias(ctx.auth.accountId, ctx.params.friendId, '');
    ctx.noContent();
  });
  router.put('/friends/api/v1/:accountId/friends/:friendId/note', ownAccount(), (ctx) => {
    ctx.services.friends.setNote(ctx.auth.accountId, ctx.params.friendId, ctx.rawBody.toString('utf8').trim().slice(0, 256));
    ctx.noContent();
  });
  router.post('/friends/api/v1/:accountId/blocklist/:blockedId', ownAccount(), (ctx) => {
    ctx.services.friends.block(ctx.auth.accountId, ctx.params.blockedId);
    ctx.noContent();
  });
  router.delete('/friends/api/v1/:accountId/blocklist/:blockedId', ownAccount(), (ctx) => {
    ctx.services.friends.unblock(ctx.auth.accountId, ctx.params.blockedId);
    ctx.noContent();
  });

  // ---- party service v1 ---------------------------------------------------------------------
  const P = '/party/api/v1/Fortnite';
  router.get(`${P}/user/:accountId`, ownAccount(), (ctx) => ctx.json(ctx.services.party.summary(ctx.auth.accountId)));
  router.get(`${P}/user/:accountId/notifications/undelivered/count`, ownAccount(), (ctx) => {
    ctx.json({ pings: ctx.services.party.pingsFor(ctx.auth.accountId).length, invites: ctx.services.party.summary(ctx.auth.accountId).invites.length });
  });
  router.post(`${P}/parties`, requireAccount, (ctx) => ctx.json(ctx.services.party.create(ctx.auth.accountId, ctx.body)));
  router.get(`${P}/parties/:partyId`, requireAccount, (ctx) => ctx.json(ctx.services.party.get(ctx.params.partyId)));
  router.patch(`${P}/parties/:partyId`, requireAccount, (ctx) => {
    ctx.services.party.update(ctx.params.partyId, ctx.auth.accountId, ctx.body);
    ctx.noContent();
  });
  router.patch(`${P}/parties/:partyId/members/:accountId/meta`, requireAccount, (ctx) => {
    ctx.services.party.updateMemberMeta(ctx.params.partyId, ctx.params.accountId, ctx.auth.accountId, ctx.body);
    ctx.noContent();
  });
  router.post(`${P}/parties/:partyId/members/:accountId/join`, requireAccount, (ctx) => {
    if (ctx.params.accountId !== ctx.auth.accountId) throw Errors.missingPermission(`party:${ctx.params.partyId}:join`);
    ctx.json(ctx.services.party.join(ctx.params.partyId, ctx.auth.accountId, ctx.body));
  });
  router.delete(`${P}/parties/:partyId/members/:accountId`, requireAccount, (ctx) => {
    ctx.services.party.leave(ctx.params.partyId, ctx.params.accountId, ctx.auth.accountId);
    ctx.noContent();
  });
  router.post(`${P}/parties/:partyId/members/:accountId/promote`, requireAccount, (ctx) => {
    ctx.services.party.promote(ctx.params.partyId, ctx.params.accountId, ctx.auth.accountId);
    ctx.noContent();
  });
  router.post(`${P}/parties/:partyId/invites/:accountId`, requireAccount, (ctx) => {
    ctx.services.party.invite(ctx.params.partyId, ctx.auth.accountId, ctx.params.accountId, ctx.body, ctx.query.sendPing === 'true');
    ctx.noContent();
  });
  router.post(`${P}/parties/:partyId/invites/:accountId/decline`, requireAccount, (ctx) => {
    if (ctx.params.accountId !== ctx.auth.accountId) throw Errors.missingPermission(`party:${ctx.params.partyId}:invite`);
    ctx.services.party.declineInvite(ctx.params.partyId, ctx.auth.accountId);
    ctx.noContent();
  });
  router.post(`${P}/user/:accountId/pings/:pingerId`, requireAccount, (ctx) => {
    if (ctx.params.pingerId !== ctx.auth.accountId) throw Errors.missingPermission('party:ping');
    ctx.json(ctx.services.party.ping(ctx.params.accountId, ctx.auth.accountId, ctx.body));
  });
  router.delete(`${P}/user/:accountId/pings/:pingerId`, ownAccount(), (ctx) => {
    ctx.services.party.deletePing(ctx.auth.accountId, ctx.params.pingerId);
    ctx.noContent();
  });
  router.get(`${P}/user/:accountId/pings/:pingerId/parties`, ownAccount(), (ctx) => {
    ctx.json(ctx.services.party.partiesOfPinger(ctx.auth.accountId, ctx.params.pingerId));
  });
  router.post(`${P}/user/:accountId/pings/:pingerId/join`, ownAccount(), (ctx) => {
    const [party] = ctx.services.party.partiesOfPinger(ctx.auth.accountId, ctx.params.pingerId);
    if (!party) throw Errors.partyNotFound(`of ${ctx.params.pingerId}`);
    ctx.json(ctx.services.party.join(party.id, ctx.auth.accountId, ctx.body));
  });
  router.post(`${P}/members/:accountId/intentions/:senderId`, requireAccount, (ctx) => {
    if (ctx.params.senderId !== ctx.auth.accountId) throw Errors.missingPermission('party:intention');
    ctx.json(ctx.services.party.intention(ctx.auth.accountId, ctx.params.accountId, ctx.body?.meta));
  });
}
