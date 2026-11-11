import { EventEmitter } from 'node:events';
import { Errors } from '../core/errors.js';
import { hexId, isoNow } from '../core/util.js';

/**
 * Registry of game servers that players can be matched onto. Servers register themselves
 * through the Gallium game-server API and must heartbeat; a static fallback server can be
 * configured (matchmaking.fallbackServer) for setups where the server never registers.
 */
export function createGameServerRegistry({ config, log }) {
  const gLog = log.child('gameservers');
  const servers = new Map();
  const events = new EventEmitter();
  const timeoutMs = config.gameServers.heartbeatTimeoutSeconds * 1000;

  function normalizePlaylists(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw Errors.validation('playlists must be an array of playlist names');
    return list.map((p) => p.toLowerCase());
  }

  function register(body = {}, { permanent = false } = {}) {
    const address = body.address ?? body.ip;
    const port = Number(body.port);
    if (typeof address !== 'string' || !address) throw Errors.validation('address is required');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Errors.validation('port must be 1-65535');
    const maxPlayers = body.maxPlayers === undefined ? 100 : Number(body.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000) throw Errors.validation('maxPlayers must be 1-1000');
    const server = {
      id: body.id && typeof body.id === 'string' ? body.id : hexId(),
      name: typeof body.name === 'string' ? body.name.slice(0, 64) : `${address}:${port}`,
      address,
      port,
      region: typeof body.region === 'string' ? body.region.toUpperCase() : config.matchmaking.defaultRegion,
      playlists: normalizePlaylists(body.playlists),
      maxPlayers,
      customKey: typeof body.customKey === 'string' ? body.customKey : null,
      buildUniqueId: body.buildUniqueId != null ? String(body.buildUniqueId) : null,
      state: 'open',
      sessionId: hexId(),
      matchId: hexId(),
      players: new Set(),
      reserved: 0,
      permanent,
      registeredAt: isoNow(),
      lastHeartbeat: Date.now(),
    };
    servers.set(server.id, server);
    gLog.info(`Registered game server ${server.name} (${server.region}, playlists: ${server.playlists.join(', ') || 'any'})`);
    events.emit('available', server);
    return server;
  }

  function require(id) {
    const s = servers.get(id);
    if (!s) throw Errors.notFound(`game server ${id}`);
    return s;
  }

  function heartbeat(id, body = {}) {
    const s = require(id);
    s.lastHeartbeat = Date.now();
    if (body.state !== undefined) {
      if (!['open', 'started', 'closed'].includes(body.state)) throw Errors.validation('state must be open, started or closed');
      const wasOpen = s.state === 'open';
      s.state = body.state;
      if (!wasOpen && s.state === 'open') events.emit('available', s);
    }
    return s;
  }

  /** Start a fresh match on the server (new session id, empty player list). */
  function resetSession(id) {
    const s = require(id);
    s.sessionId = hexId();
    s.matchId = hexId();
    s.players.clear();
    s.reserved = 0;
    s.state = 'open';
    events.emit('available', s);
    return s;
  }

  function remove(id) {
    const s = servers.get(id);
    if (!s) return false;
    servers.delete(id);
    gLog.info(`Removed game server ${s.name}`);
    return true;
  }

  function freeSlots(s) {
    return s.maxPlayers - s.players.size - s.reserved;
  }

  /** Best open server for a ticket: matching playlist and custom key, same region preferred. */
  function pickFor({ playlist, region, partySize = 1, customKey = null }) {
    const pl = String(playlist || '').toLowerCase();
    const candidates = [...servers.values()].filter(
      (s) => s.state === 'open' && freeSlots(s) >= partySize && (!s.playlists.length || s.playlists.includes(pl)) && (s.customKey || null) === (customKey || null),
    );
    candidates.sort((a, b) => Number(b.region === region) - Number(a.region === region) || freeSlots(b) - freeSlots(a));
    return candidates[0] || null;
  }

  function bySession(sessionId) {
    for (const s of servers.values()) if (s.sessionId === sessionId) return s;
    return null;
  }

  function pruneDead() {
    const now = Date.now();
    for (const s of servers.values()) {
      if (!s.permanent && now - s.lastHeartbeat > timeoutMs) {
        gLog.warn(`Game server ${s.name} missed heartbeats; removing it`);
        servers.delete(s.id);
      }
    }
  }

  function view(s) {
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      port: s.port,
      region: s.region,
      playlists: s.playlists,
      maxPlayers: s.maxPlayers,
      players: [...s.players],
      reserved: s.reserved,
      state: s.state,
      sessionId: s.sessionId,
      matchId: s.matchId,
      customKey: s.customKey,
      permanent: s.permanent,
      registeredAt: s.registeredAt,
      lastHeartbeat: new Date(s.lastHeartbeat).toISOString(),
    };
  }

  if (config.matchmaking.fallbackServer) {
    register({ id: 'fallback', name: 'fallback', ...config.matchmaking.fallbackServer }, { permanent: true });
  }

  return { events, register, heartbeat, resetSession, remove, get: require, pickFor, bySession, freeSlots, pruneDead, list: () => [...servers.values()].map(view), view };
}
