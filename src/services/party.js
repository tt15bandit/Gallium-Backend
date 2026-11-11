import { Errors } from '../core/errors.js';
import { hexId, isoNow, isoIn, isPlainObject } from '../core/util.js';

const NOTIFY = 'com.epicgames.social.party.notification.v0.';
const DEFAULT_CONFIG = { type: 'DEFAULT', joinability: 'OPEN', discoverability: 'ALL', sub_type: 'default', max_size: 16, invite_ttl: 14400, join_confirmation: false, intention_ttl: 60 };

/**
 * Party service v1 (/party/api/v1/Fortnite/...). Parties are live, in-memory state; every change
 * is pushed to members over XMPP as party notifications. Members whose XMPP connection drops
 * are removed after a grace period (the client creates parties with RemoveOnDisconnect).
 */
export function createPartyService({ accounts, xmpp, log, disconnectGraceMs = 30000 }) {
  const pLog = log.child('party');
  const parties = new Map();
  const memberOf = new Map(); // accountId -> partyId
  const pings = new Map(); // toAccountId -> Map<fromAccountId, ping>
  const intentions = new Map(); // targetId -> Map<requesterId, intention>
  const pendingRemovals = new Map();

  const dn = (id) => accounts.get(id)?.displayName || id;
  const send = (ids, type, payload) => {
    const sent = isoNow();
    for (const id of ids) xmpp.sendJson(id, { type: NOTIFY + type, sent, ns: 'Fortnite', ...payload });
  };
  const memberIds = (party) => party.members.map((m) => m.account_id);

  function requireParty(partyId) {
    const party = parties.get(partyId);
    if (!party) throw Errors.partyNotFound(partyId);
    return party;
  }

  function requireMember(party, accountId) {
    const m = party.members.find((x) => x.account_id === accountId);
    if (!m) throw Errors.partyMemberNotFound(accountId);
    return m;
  }

  function connection(conn = {}, accountId) {
    const now = isoNow();
    return {
      id: typeof conn.id === 'string' && conn.id ? conn.id : `${accountId}@${xmppDomain()}`,
      connected_at: now,
      updated_at: now,
      yield_leadership: !!conn.yield_leadership,
      meta: isPlainObject(conn.meta) ? conn.meta : {},
    };
  }

  let domainName = 'prod.ol.epicgames.com';
  const xmppDomain = () => domainName;

  function applyMeta(target, patch) {
    const removed = Array.isArray(patch?.delete) ? patch.delete.filter((k) => typeof k === 'string') : [];
    const updated = isPlainObject(patch?.update) ? patch.update : {};
    for (const k of removed) delete target[k];
    Object.assign(target, updated);
    return { removed, updated };
  }

  function partyUpdatedPayload(party, removed, updated) {
    const captain = party.members.find((m) => m.role === 'CAPTAIN');
    return {
      party_id: party.id,
      captain_id: captain?.account_id,
      party_state_removed: removed,
      party_state_updated: updated,
      party_state_overridden: {},
      party_privacy_type: party.config.joinability,
      party_type: party.config.type,
      party_sub_type: party.config.sub_type,
      max_number_of_members: party.config.max_size,
      invite_ttl_seconds: party.config.invite_ttl,
      intention_ttl_seconds: party.config.intention_ttl,
      created_at: party.created_at,
      updated_at: party.updated_at,
      revision: party.revision,
    };
  }

  function create(accountId, body = {}) {
    if (memberOf.has(accountId)) leave(memberOf.get(accountId), accountId, accountId);
    const now = isoNow();
    const join = isPlainObject(body.join_info) ? body.join_info : {};
    const party = {
      id: hexId(),
      created_at: now,
      updated_at: now,
      config: { ...DEFAULT_CONFIG, ...(isPlainObject(body.config) ? body.config : {}) },
      members: [
        {
          account_id: accountId,
          meta: isPlainObject(join.meta) ? { ...join.meta } : {},
          connections: [connection(join.connection, accountId)],
          revision: 0,
          updated_at: now,
          joined_at: now,
          role: 'CAPTAIN',
        },
      ],
      applicants: [],
      meta: isPlainObject(body.meta) ? { ...body.meta } : {},
      invites: [],
      revision: 0,
      intentions: [],
    };
    parties.set(party.id, party);
    memberOf.set(accountId, party.id);
    pLog.debug(`${dn(accountId)} created party ${party.id}`);
    return party;
  }

  function update(partyId, actorId, body = {}) {
    const party = requireParty(partyId);
    if (requireMember(party, actorId).role !== 'CAPTAIN') throw Errors.partyNotLeader();
    if (isPlainObject(body.config)) Object.assign(party.config, body.config);
    const { removed, updated } = applyMeta(party.meta, body.meta);
    party.revision++;
    party.updated_at = isoNow();
    send(memberIds(party), 'PARTY_UPDATED', partyUpdatedPayload(party, removed, updated));
  }

  function updateMemberMeta(partyId, memberId, actorId, body = {}) {
    if (memberId !== actorId) throw Errors.missingPermission(`party:${partyId}:member:${memberId}`, 'UPDATE');
    const party = requireParty(partyId);
    const member = requireMember(party, memberId);
    const { removed, updated } = applyMeta(member.meta, body);
    member.revision++;
    member.updated_at = isoNow();
    send(memberIds(party), 'MEMBER_STATE_UPDATED', {
      party_id: party.id,
      account_id: memberId,
      account_dn: dn(memberId),
      member_state_removed: removed,
      member_state_updated: updated,
      member_state_overridden: {},
      joined_at: member.joined_at,
      updated_at: member.updated_at,
      revision: member.revision,
    });
  }

  function join(partyId, accountId, body = {}) {
    const party = requireParty(partyId);
    const existing = party.members.find((m) => m.account_id === accountId);
    if (existing) {
      existing.connections = [connection(body.connection, accountId)];
      return { status: 'JOINED', party_id: party.id };
    }
    if (party.members.length >= party.config.max_size) throw Errors.partyFull(partyId);
    if (memberOf.has(accountId)) leave(memberOf.get(accountId), accountId, accountId);
    const now = isoNow();
    const member = {
      account_id: accountId,
      meta: isPlainObject(body.meta) ? { ...body.meta } : {},
      connections: [connection(body.connection, accountId)],
      revision: 0,
      updated_at: now,
      joined_at: now,
      role: 'MEMBER',
    };
    party.members.push(member);
    party.invites = party.invites.filter((i) => i.sent_to !== accountId);
    memberOf.set(accountId, party.id);
    party.revision++;
    party.updated_at = now;
    for (const m of party.members) pings.get(accountId)?.delete(m.account_id);
    send(memberIds(party), 'MEMBER_JOINED', {
      party_id: party.id,
      account_id: accountId,
      account_dn: dn(accountId),
      connection: member.connections[0],
      member_state_updated: member.meta,
      revision: member.revision,
      joined_at: member.joined_at,
      updated_at: member.updated_at,
    });
    pLog.debug(`${dn(accountId)} joined party ${party.id}`);
    return { status: 'JOINED', party_id: party.id };
  }

  function leave(partyId, memberId, actorId) {
    const party = requireParty(partyId);
    const member = requireMember(party, memberId);
    const kicked = memberId !== actorId;
    if (kicked && requireMember(party, actorId).role !== 'CAPTAIN') throw Errors.partyNotLeader();
    const recipients = memberIds(party);
    party.members = party.members.filter((m) => m !== member);
    memberOf.delete(memberId);
    party.revision++;
    party.updated_at = isoNow();
    send(recipients, kicked ? 'MEMBER_KICKED' : 'MEMBER_LEFT', { party_id: party.id, account_id: memberId, member_state_updated: {}, revision: party.revision });
    if (!party.members.length) {
      parties.delete(party.id);
      pLog.debug(`Party ${party.id} disbanded`);
      return;
    }
    if (member.role === 'CAPTAIN') {
      const next = [...party.members].sort((a, b) => a.joined_at.localeCompare(b.joined_at))[0];
      next.role = 'CAPTAIN';
      announceCaptain(party, next);
    }
  }

  function announceCaptain(party, member) {
    send(memberIds(party), 'MEMBER_NEW_CAPTAIN', {
      party_id: party.id,
      account_id: member.account_id,
      account_dn: dn(member.account_id),
      member_state_updated: {},
      joined_at: member.joined_at,
      updated_at: isoNow(),
      revision: party.revision,
    });
  }

  function promote(partyId, memberId, actorId) {
    const party = requireParty(partyId);
    if (requireMember(party, actorId).role !== 'CAPTAIN') throw Errors.partyNotLeader();
    const target = requireMember(party, memberId);
    for (const m of party.members) m.role = m === target ? 'CAPTAIN' : 'MEMBER';
    party.revision++;
    announceCaptain(party, target);
  }

  function invite(partyId, inviterId, inviteeId, meta = {}, sendPing = false) {
    const party = requireParty(partyId);
    requireMember(party, inviterId);
    accounts.require(inviteeId);
    const now = isoNow();
    const inv = { party_id: party.id, sent_by: inviterId, meta: isPlainObject(meta) ? meta : {}, sent_to: inviteeId, sent_at: now, updated_at: now, expires_at: isoIn(party.config.invite_ttl * 1000), status: 'SENT' };
    party.invites = party.invites.filter((i) => i.sent_to !== inviteeId).concat(inv);
    send([inviteeId], 'INITIAL_INVITE', {
      party_id: party.id,
      inviter_id: inviterId,
      inviter_dn: dn(inviterId),
      invitee_id: inviteeId,
      meta: inv.meta,
      members_count: party.members.length,
      friends_ids: party.members.map((m) => m.account_id).filter((id) => id !== inviterId),
      sent_at: now,
      updated_at: now,
      expires: inv.expires_at,
    });
    if (sendPing) ping(inviteeId, inviterId, meta);
    return inv;
  }

  function declineInvite(partyId, accountId) {
    const party = requireParty(partyId);
    const inv = party.invites.find((i) => i.sent_to === accountId);
    if (!inv) throw Errors.notFound(`an invite for ${accountId}`);
    party.invites = party.invites.filter((i) => i !== inv);
    send(memberIds(party), 'INVITE_DECLINED', { party_id: party.id, invitee_id: accountId, invitee_dn: dn(accountId), inviter_id: inv.sent_by, inviter_dn: dn(inv.sent_by), updated_at: isoNow() });
  }

  function ping(toId, fromId, meta = {}) {
    accounts.require(toId);
    const now = isoNow();
    const p = { sent_by: fromId, sent_to: toId, sent_at: now, expires_at: isoIn(3600 * 1000), meta: isPlainObject(meta) ? meta : {} };
    if (!pings.has(toId)) pings.set(toId, new Map());
    pings.get(toId).set(fromId, p);
    send([toId], 'PING', { pinger_id: fromId, pinger_dn: dn(fromId), pinger_pl: 'WIN', pinger_pl_dn: dn(fromId), expires: p.expires_at, meta: p.meta });
    return p;
  }

  function pingsFor(accountId) {
    const now = isoNow();
    return [...(pings.get(accountId)?.values() || [])].filter((p) => p.expires_at > now);
  }

  function intention(requesterId, targetId, meta = {}) {
    accounts.require(targetId);
    const now = isoNow();
    const i = { requester_id: requesterId, requester_dn: dn(requesterId), requester_pl: 'WIN', requester_pl_dn: dn(requesterId), requestee_id: targetId, meta: isPlainObject(meta) ? meta : {}, expires_at: isoIn(60000), sent_at: now };
    if (!intentions.has(targetId)) intentions.set(targetId, new Map());
    intentions.get(targetId).set(requesterId, i);
    send([targetId], 'INITIAL_INTENTION', i);
    return i;
  }

  function summary(accountId) {
    const current = memberOf.has(accountId) ? [parties.get(memberOf.get(accountId))].filter(Boolean) : [];
    const invites = [];
    for (const party of parties.values()) for (const inv of party.invites) if (inv.sent_to === accountId) invites.push(inv);
    return { current, pending: [], invites, pings: pingsFor(accountId) };
  }

  // Remove members whose XMPP connection is gone for longer than the grace period.
  xmpp.events.on('offline', (accountId) => {
    if (!memberOf.has(accountId)) return;
    clearTimeout(pendingRemovals.get(accountId));
    const t = setTimeout(() => {
      pendingRemovals.delete(accountId);
      if (xmpp.isOnline(accountId) || !memberOf.has(accountId)) return;
      pLog.debug(`Removing disconnected ${dn(accountId)} from party`);
      try {
        leave(memberOf.get(accountId), accountId, accountId);
      } catch {
        /* party already gone */
      }
    }, disconnectGraceMs);
    t.unref();
    pendingRemovals.set(accountId, t);
  });
  xmpp.events.on('online', (accountId) => {
    clearTimeout(pendingRemovals.get(accountId));
    pendingRemovals.delete(accountId);
  });

  return {
    setDomain: (d) => {
      domainName = d;
    },
    create,
    get: requireParty,
    update,
    updateMemberMeta,
    join,
    leave,
    promote,
    invite,
    declineInvite,
    ping,
    deletePing: (toId, fromId) => pings.get(toId)?.delete(fromId),
    pingsFor,
    partiesOfPinger(toId, fromId) {
      if (!pings.get(toId)?.has(fromId)) throw Errors.pingNotFound();
      const pid = memberOf.get(fromId);
      return pid && parties.has(pid) ? [parties.get(pid)] : [];
    },
    partyOf: (accountId) => (memberOf.has(accountId) ? parties.get(memberOf.get(accountId)) : null),
    intention,
    summary,
    get count() {
      return parties.size;
    },
    shutdown() {
      for (const t of pendingRemovals.values()) clearTimeout(t);
      pendingRemovals.clear();
    },
  };
}
