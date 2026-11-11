import crypto from 'node:crypto';
import { hexId, hmacHex, isoNow, safeEqual } from '../core/util.js';
import { Errors } from '../core/errors.js';

/**
 * Matchmaking:
 *  1. GET  /fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId  -> signed ticket
 *  2. client opens a WebSocket to ticket.serviceUrl with
 *     "Authorization: Epic-Signed mms-player <payload> <signature>"
 *  3. we stream StatusUpdate messages (Connecting, Waiting, Queued, SessionAssignment) and a
 *     final "Play" message once a registered game server has room
 *  4. the client fetches /fortnite/api/matchmaking/session/:sessionId and connects.
 */
export function createMatchmakingService({ config, log, gameServers, repos }) {
  const mLog = log.child('matchmaking');
  let secret = repos.settings.get('matchmaking_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    repos.settings.set('matchmaking_secret', secret);
  }
  const queue = []; // { ticket, ws, queuedAt }
  const sessionBuild = new Map(); // sessionId -> buildUniqueId (netcl) seen in tickets

  /** bucketId = "<netcl>:<hotfixVersion>:<region>:<playlist>" */
  function parseBucket(bucketId) {
    const parts = String(bucketId || '').split(':');
    if (parts.length < 4) throw Errors.validation('bucketId must look like "<netcl>:<hotfix>:<region>:<playlist>"');
    return { netcl: parts[0], hotfix: parts[1], region: parts[2].toUpperCase() || config.matchmaking.defaultRegion, playlist: parts.slice(3).join(':') };
  }

  /** `reachedVia` = "host:port" the client used for the ticket request, so friends get a reachable URL. */
  function serviceUrl(reachedVia) {
    if (config.matchmaking.serviceUrl) return config.matchmaking.serviceUrl;
    if (reachedVia) return `ws://${reachedVia}/matchmaking`;
    const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
    return `ws://${host}:${config.server.port}/matchmaking`;
  }

  function createTicket(accountId, query, reachedVia) {
    const bucket = parseBucket(query.bucketId);
    const party = String(query.partyPlayerIds || accountId).split(',').filter(Boolean);
    if (!party.includes(accountId)) party.push(accountId);
    const data = {
      ticketId: hexId(),
      accountId,
      partyPlayerIds: party.slice(0, 16),
      bucketId: query.bucketId,
      ...bucket,
      customKey: query['player.option.customKey'] || null,
      subregions: query['player.subregions'] || '',
      platform: query['player.platform'] || 'Windows',
      exp: Date.now() + config.matchmaking.ticketTtlSeconds * 1000,
    };
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    return { serviceUrl: serviceUrl(reachedVia), ticketType: 'mms-player', payload, signature: hmacHex(secret, payload) };
  }

  /** Validate "Epic-Signed mms-player <payload> <signature>". */
  function verifyAuthorization(header) {
    const m = /^Epic-Signed\s+mms-player\s+(\S+)\s+(\S+)$/i.exec(String(header || '').trim());
    if (!m) return null;
    const [, payload, signature] = m;
    if (!safeEqual(hmacHex(secret, payload), signature)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  const status = (ws, payload) => ws.send(JSON.stringify({ payload, name: 'StatusUpdate' }));

  function handleConnection(ws, ticket) {
    const entry = { ticket, ws, queuedAt: Date.now() };
    status(ws, { state: 'Connecting' });
    status(ws, { totalPlayers: ticket.partyPlayerIds.length, connectedPlayers: ticket.partyPlayerIds.length, state: 'Waiting' });
    queue.push(entry);
    sendQueued(entry);
    ws.on('close', () => removeFromQueue(entry));
    ws.on('error', () => {});
    mLog.info(`${ticket.accountId} queued for ${ticket.playlist} in ${ticket.region}`);
    process.nextTick(tryAssign);
  }

  function sendQueued(entry) {
    status(entry.ws, { ticketId: entry.ticket.ticketId, queuedPlayers: queue.length, estimatedWaitSec: 0, status: {}, state: 'Queued' });
  }

  function removeFromQueue(entry) {
    const i = queue.indexOf(entry);
    if (i !== -1) queue.splice(i, 1);
  }

  function tryAssign() {
    for (const entry of [...queue]) {
      if (entry.ws.state !== 'open') {
        removeFromQueue(entry);
        continue;
      }
      const { ticket } = entry;
      const server = gameServers.pickFor({ playlist: ticket.playlist, region: ticket.region, partySize: ticket.partyPlayerIds.length, customKey: ticket.customKey });
      if (!server) continue;
      removeFromQueue(entry);
      server.reserved += ticket.partyPlayerIds.length;
      sessionBuild.set(server.sessionId, ticket.netcl);
      const { matchId, sessionId } = server;
      status(entry.ws, { matchId, state: 'SessionAssignment' });
      setTimeout(() => {
        if (entry.ws.state !== 'open') return;
        entry.ws.send(JSON.stringify({ payload: { matchId, sessionId, joinDelaySec: 1 }, name: 'Play' }));
        setTimeout(() => entry.ws.close(1000, ''), 1000).unref();
      }, 250).unref();
      mLog.info(`Assigned ${ticket.accountId} to ${server.name} (session ${sessionId})`);
    }
  }

  // Re-check the queue whenever a server becomes available, and keep queued clients updated.
  gameServers.events.on('available', () => process.nextTick(tryAssign));
  const ticker = setInterval(() => {
    for (const entry of queue) if (entry.ws.state === 'open') sendQueued(entry);
    tryAssign();
  }, 5000);
  ticker.unref();

  /** Session document for GET /fortnite/api/matchmaking/session/:sessionId */
  function sessionView(sessionId) {
    const s = gameServers.bySession(sessionId);
    if (!s) throw Errors.sessionNotFound(sessionId);
    const playlist = s.playlists[0] || 'playlist_defaultsolo';
    return {
      id: s.sessionId,
      ownerId: hexId().toUpperCase(),
      ownerName: '[DS]gallium',
      serverName: `[DS]${s.name}`,
      serverAddress: s.address,
      serverPort: s.port,
      maxPublicPlayers: s.maxPlayers,
      openPublicPlayers: Math.max(0, gameServers.freeSlots(s)),
      maxPrivatePlayers: 0,
      openPrivatePlayers: 0,
      attributes: {
        REGION_s: s.region,
        GAMEMODE_s: 'FORTATHENA',
        ALLOWBROADCASTING_b: true,
        SUBREGION_s: s.region,
        DCID_s: 'GALLIUM-LOCAL',
        tenant_s: 'Fortnite',
        MATCHMAKINGPOOL_s: 'Any',
        STORMSHIELDDEFENSETYPE_i: 0,
        HOTFIXVERSION_i: 0,
        PLAYLISTNAME_s: playlist,
        SESSIONKEY_s: s.matchId,
        TENANT_s: 'Fortnite',
        BEACONPORT_i: 15009,
      },
      publicPlayers: [...s.players],
      privatePlayers: [],
      totalPlayers: s.players.size,
      allowJoinInProgress: false,
      shouldAdvertise: false,
      isDedicated: false,
      usesStats: false,
      allowInvites: false,
      usesPresence: false,
      allowJoinViaPresence: true,
      allowJoinViaPresenceFriendsOnly: false,
      buildUniqueId: s.buildUniqueId || sessionBuild.get(s.sessionId) || '0',
      lastUpdated: isoNow(),
      started: s.state === 'started',
    };
  }

  function joinSession(sessionId, accountId) {
    const s = gameServers.bySession(sessionId);
    if (!s) throw Errors.sessionNotFound(sessionId);
    if (!s.players.has(accountId)) {
      s.players.add(accountId);
      s.reserved = Math.max(0, s.reserved - 1);
    }
    return s;
  }

  return {
    createTicket,
    verifyAuthorization,
    handleConnection,
    sessionView,
    joinSession,
    queueLength: () => queue.length,
    shutdown() {
      clearInterval(ticker);
      for (const e of queue) e.ws.close(1001, 'server shutting down');
      queue.length = 0;
    },
  };
}
