import { Errors } from '../core/errors.js';
import { isoNow } from '../core/util.js';

/**
 * Friends and block lists (friends-public-service). Each friendship is stored as two rows,
 * one per direction, so both "public" (legacy) and "v1" APIs can be answered directly.
 */
export function createFriendsService({ repos, accounts, xmpp, log }) {
  const fLog = log.child('friends');

  function notifyFriend(to, other, status, direction, created) {
    const timestamp = isoNow();
    xmpp.sendJson(to, { payload: { accountId: other, status, direction, created, favorite: false }, type: 'com.epicgames.friends.core.apiobjects.Friend', timestamp });
    xmpp.sendJson(to, { type: 'FRIENDSHIP_REQUEST', timestamp, from: direction === 'INBOUND' ? other : to, to: direction === 'INBOUND' ? to : other, status });
  }

  function notifyRemoval(to, other) {
    const timestamp = isoNow();
    xmpp.sendJson(to, { payload: { accountId: other, reason: 'DELETED' }, type: 'com.epicgames.friends.core.apiobjects.FriendRemoval', timestamp });
    xmpp.sendJson(to, { type: 'FRIENDSHIP_REMOVE', timestamp, from: to, to: other, reason: 'DELETED' });
  }

  /** Send or accept a request. Returns the resulting status for `from`. */
  function request(from, to) {
    if (from === to) throw Errors.friendSelf();
    accounts.require(to);
    if (repos.blocks.isBlocked(to, from) || repos.blocks.isBlocked(from, to)) throw Errors.friendNotFound(to);
    const mine = repos.friends.get(from, to);
    if (mine?.status === 'ACCEPTED') return 'ACCEPTED';
    if (mine?.direction === 'INBOUND') {
      const created = isoNow();
      repos.friends.upsert({ ...mine, status: 'ACCEPTED', created });
      repos.friends.upsert({ ...repos.friends.get(to, from), status: 'ACCEPTED', created });
      notifyFriend(from, to, 'ACCEPTED', 'INBOUND', created);
      notifyFriend(to, from, 'ACCEPTED', 'OUTBOUND', created);
      xmpp.exchangePresence(from, to);
      fLog.info(`${from} and ${to} are now friends`);
      return 'ACCEPTED';
    }
    if (mine?.direction === 'OUTBOUND') return 'PENDING';
    const created = isoNow();
    repos.friends.upsert({ accountId: from, friendId: to, status: 'PENDING', direction: 'OUTBOUND', created });
    repos.friends.upsert({ accountId: to, friendId: from, status: 'PENDING', direction: 'INBOUND', created });
    notifyFriend(from, to, 'PENDING', 'OUTBOUND', created);
    notifyFriend(to, from, 'PENDING', 'INBOUND', created);
    return 'PENDING';
  }

  function remove(a, b) {
    const removed = repos.friends.delete(a, b) + repos.friends.delete(b, a);
    if (!removed) throw Errors.friendNotFound(b);
    notifyRemoval(a, b);
    notifyRemoval(b, a);
    xmpp.removePresence(a, b);
  }

  function friendIds(accountId) {
    return repos.friends.list(accountId).filter((f) => f.status === 'ACCEPTED').map((f) => f.friendId);
  }

  return {
    request,
    remove,
    friendIds,
    areFriends: (a, b) => repos.friends.get(a, b)?.status === 'ACCEPTED',
    list: (accountId) => repos.friends.list(accountId),
    get: (a, b) => repos.friends.get(a, b),
    setAlias(a, b, alias) {
      const f = repos.friends.get(a, b);
      if (!f || f.status !== 'ACCEPTED') throw Errors.friendNotFound(b);
      repos.friends.upsert({ ...f, alias });
    },
    setNote(a, b, note) {
      const f = repos.friends.get(a, b);
      if (!f || f.status !== 'ACCEPTED') throw Errors.friendNotFound(b);
      repos.friends.upsert({ ...f, note });
    },
    block(a, b) {
      if (a === b) throw Errors.validation('You cannot block yourself');
      accounts.require(b);
      if (repos.friends.get(a, b)) remove(a, b);
      repos.blocks.add(a, b, isoNow());
    },
    unblock: (a, b) => repos.blocks.remove(a, b),
    blocklist: (accountId) => repos.blocks.list(accountId),
    /** Legacy /friends/api/public/friends format. */
    legacyList(accountId, includePending) {
      return repos.friends
        .list(accountId)
        .filter((f) => includePending || f.status === 'ACCEPTED')
        .map((f) => ({ accountId: f.friendId, status: f.status, direction: f.direction, created: f.created, favorite: f.favorite }));
    },
    /** v1 /friends/api/v1/:accountId/summary format. */
    summary(accountId) {
      const all = repos.friends.list(accountId);
      const v1 = (f) => ({ accountId: f.friendId, groups: [], mutual: 0, alias: f.alias, note: f.note, favorite: f.favorite, created: f.created });
      return {
        friends: all.filter((f) => f.status === 'ACCEPTED').map(v1),
        incoming: all.filter((f) => f.status === 'PENDING' && f.direction === 'INBOUND').map((f) => ({ accountId: f.friendId, mutual: 0, favorite: false, created: f.created })),
        outgoing: all.filter((f) => f.status === 'PENDING' && f.direction === 'OUTBOUND').map((f) => ({ accountId: f.friendId, mutual: 0, favorite: false, created: f.created })),
        suggested: [],
        blocklist: repos.blocks.list(accountId).map((b) => ({ accountId: b.accountId })),
        settings: { acceptInvites: 'public' },
      };
    },
  };
}
