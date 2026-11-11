import { EventEmitter } from 'node:events';
import { el, parseXml, serialize, XmlStreamSplitter } from '../core/xml.js';
import { hexId, isoNow } from '../core/util.js';

const NS = {
  framing: 'urn:ietf:params:xml:ns:xmpp-framing',
  streams: 'http://etherx.jabber.org/streams',
  sasl: 'urn:ietf:params:xml:ns:xmpp-sasl',
  bind: 'urn:ietf:params:xml:ns:xmpp-bind',
  session: 'urn:ietf:params:xml:ns:xmpp-session',
  stanzas: 'urn:ietf:params:xml:ns:xmpp-stanzas',
  ping: 'urn:xmpp:ping',
  roster: 'jabber:iq:roster',
  muc: 'http://jabber.org/protocol/muc',
  mucUser: 'http://jabber.org/protocol/muc#user',
};

/**
 * XMPP server for Fortnite's friends presence, whispers, party chat (MUC) and backend
 * notifications. Three transports feed the same session logic:
 *   - WebSocket with RFC 7395 framing (<open/> per frame)       e.g. 32.00 (wss)
 *   - WebSocket carrying a classic <stream:stream>               e.g. 5.41-21.50 (ws://:5222)
 *   - raw TCP <stream:stream>                                    e.g. 3.1 / 4.5
 * Authentication is SASL PLAIN with the account id and a Gallium access token.
 */
export function createXmppService({ config, log, auth }) {
  const xLog = log.child('xmpp');
  const domain = config.xmpp.domain;
  const mucDomain = config.xmpp.mucDomain;
  const events = new EventEmitter();
  const sessions = new Map(); // accountId -> Set<Session>
  const rooms = new Map(); // room bare jid (lowercase) -> Map<session, nick>
  let friendResolver = () => [];

  class Session {
    constructor(transport, mode) {
      this.id = hexId();
      this.transport = transport; // { send(text), close(), remote }
      this.mode = mode; // 'rfc7395' | 'stream'
      this.authenticated = false;
      this.accountId = null;
      this.displayName = null;
      this.resource = null;
      this.presence = null;
      this.rooms = new Set();
      this.closed = false;
    }

    get bareJid() {
      return `${this.accountId}@${domain}`;
    }

    get jid() {
      return `${this.bareJid}/${this.resource}`;
    }

    send(node) {
      if (this.closed) return;
      this.transport.send(typeof node === 'string' ? node : serialize(node));
    }

    openStream() {
      if (this.mode === 'rfc7395') {
        this.send(el('open', { xmlns: NS.framing, from: domain, id: this.id, version: '1.0', 'xml:lang': 'en' }));
      } else {
        this.send(`<?xml version="1.0"?>${serialize(el('stream:stream', { xmlns: 'jabber:client', 'xmlns:stream': NS.streams, from: domain, id: this.id, version: '1.0', 'xml:lang': 'en' }), { open: true })}`);
      }
      const features = this.authenticated
        ? [el('bind', { xmlns: NS.bind }), el('session', { xmlns: NS.session }), el('ver', { xmlns: 'urn:xmpp:features:rosterver' })]
        : [el('mechanisms', { xmlns: NS.sasl }, [el('mechanism', {}, 'PLAIN')]), el('ver', { xmlns: 'urn:xmpp:features:rosterver' })];
      this.send(el('stream:features', { 'xmlns:stream': NS.streams }, features));
    }

    close(reason) {
      if (this.closed) return;
      if (reason) xLog.debug(`Closing session ${this.accountId || this.id}: ${reason}`);
      try {
        this.send(this.mode === 'rfc7395' ? el('close', { xmlns: NS.framing }) : '</stream:stream>');
      } catch {
        /* transport already gone */
      }
      this.closed = true;
      this.transport.close();
      detach(this);
    }
  }

  // ---- connection entry points -------------------------------------------------------------

  /** Attach an accepted WebSocket (see core/http/websocket.js). */
  function handleWebSocket(ws) {
    let session = null;
    let splitter = null;
    const transport = { send: (t) => ws.send(t), close: () => ws.close(), remote: ws.remoteAddress };
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      try {
        if (!session) {
          const legacy = /^\s*(<\?xml[^>]*>\s*)?<stream:stream/.test(text);
          session = new Session(transport, legacy ? 'stream' : 'rfc7395');
          if (legacy) splitter = new XmlStreamSplitter();
        }
        if (splitter) return feedStream(session, splitter, text);
        const node = parseXml(text);
        if (node.local === 'open') return onOpen(session);
        if (node.local === 'close') return session.close('client closed stream');
        onStanza(session, node);
      } catch (err) {
        xLog.warn(`Bad XMPP frame from ${transport.remote}: ${err.message}`);
        session?.close('protocol error');
      }
    });
    const keepAlive = setInterval(() => ws.ping(), 30000);
    keepAlive.unref();
    ws.on('close', () => {
      clearInterval(keepAlive);
      if (session && !session.closed) {
        session.closed = true;
        detach(session);
      }
    });
    ws.on('error', () => {});
  }

  /** Attach a raw TCP socket; `firstChunk` is data already read while sniffing the protocol. */
  function handleTcp(socket, firstChunk) {
    const transport = { send: (t) => socket.write(t), close: () => socket.end(), remote: socket.remoteAddress };
    const session = new Session(transport, 'stream');
    const splitter = new XmlStreamSplitter();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const onData = (text) => {
      try {
        feedStream(session, splitter, text);
      } catch (err) {
        xLog.warn(`Bad XMPP data from ${transport.remote}: ${err.message}`);
        session.close('protocol error');
      }
    };
    socket.on('data', onData);
    const keepAlive = setInterval(() => !socket.destroyed && socket.write(' '), 60000);
    keepAlive.unref();
    socket.on('close', () => {
      clearInterval(keepAlive);
      if (!session.closed) {
        session.closed = true;
        detach(session);
      }
    });
    socket.on('error', () => {});
    if (firstChunk) onData(firstChunk.toString('utf8'));
  }

  function feedStream(session, splitter, text) {
    for (const ev of splitter.push(text)) {
      if (ev.type === 'open') onOpen(session);
      else if (ev.type === 'close') session.close('client closed stream');
      else onStanza(session, parseXml(ev.xml));
    }
  }

  function onOpen(session) {
    session.openStream();
  }

  // ---- stanza handling ----------------------------------------------------------------------

  function onStanza(session, node) {
    if (!session.authenticated) {
      if (node.local === 'auth') return onAuth(session, node);
      return session.close('stanza before authentication');
    }
    switch (node.local) {
      case 'iq':
        return onIq(session, node);
      case 'presence':
        return session.resource ? onPresence(session, node) : undefined;
      case 'message':
        return session.resource ? onMessage(session, node) : undefined;
      default:
        xLog.debug(`Ignoring <${node.name}> from ${session.accountId}`);
    }
  }

  function onAuth(session, node) {
    const fail = (why) => {
      xLog.warn(`XMPP auth failed from ${session.transport.remote}: ${why}`);
      session.send(el('failure', { xmlns: NS.sasl }, [el('not-authorized')]));
      session.close('auth failed');
    };
    if ((node.attrs.mechanism || '').toUpperCase() !== 'PLAIN') return fail(`unsupported mechanism ${node.attrs.mechanism}`);
    const decoded = Buffer.from(node.text.trim(), 'base64').toString('utf8').split('\0');
    if (decoded.length < 3) return fail('malformed PLAIN payload');
    const [authzid, authcid, password] = decoded;
    const tokenSession = auth.tryVerify(password);
    if (!tokenSession?.accountId) return fail('invalid token');
    const claimed = authcid || authzid;
    if (claimed && claimed !== tokenSession.accountId && claimed.split('@')[0] !== tokenSession.accountId) return fail('token belongs to another account');
    session.authenticated = true;
    session.accountId = tokenSession.accountId;
    session.displayName = tokenSession.account?.displayName;
    session.send(el('success', { xmlns: NS.sasl }));
  }

  function iqResult(session, node, children = []) {
    session.send(el('iq', { type: 'result', id: node.attrs.id, to: session.resource ? session.jid : undefined, from: node.attrs.to || domain, xmlns: 'jabber:client' }, children));
  }

  function iqError(session, node, condition = 'service-unavailable') {
    session.send(el('iq', { type: 'error', id: node.attrs.id, to: session.resource ? session.jid : undefined, from: domain, xmlns: 'jabber:client' }, [el('error', { type: 'cancel' }, [el(condition, { xmlns: NS.stanzas })])]));
  }

  function onIq(session, node) {
    const type = node.attrs.type;
    if (type === 'result' || type === 'error') return; // replies to our pings etc.
    const bind = node.child('bind');
    if (bind && type === 'set') {
      const requested = (bind.childText('resource') || '').trim();
      session.resource = requested || `Gallium-${session.id.slice(0, 8)}`;
      // A reconnect with the same resource replaces the old connection.
      for (const other of sessions.get(session.accountId) || []) {
        if (other !== session && other.resource === session.resource) other.close('replaced by new connection');
      }
      attach(session);
      return iqResult(session, node, [el('bind', { xmlns: NS.bind }, [el('jid', {}, session.jid)])]);
    }
    if (node.child('session')) return iqResult(session, node);
    if (node.child('ping')) return iqResult(session, node);
    const query = node.child('query');
    if (query?.attrs.xmlns === NS.roster && type === 'get') {
      const items = friendResolver(session.accountId).map((id) => el('item', { jid: `${id}@${domain}`, subscription: 'both' }));
      return iqResult(session, node, [el('query', { xmlns: NS.roster }, items)]);
    }
    const to = node.attrs.to;
    if (to && !to.startsWith(domain) && to.includes('@')) {
      const target = findByJid(to);
      if (target.length) {
        node.attrs.from = session.jid;
        for (const t of target) t.send(node);
        return;
      }
    }
    iqError(session, node);
  }

  function onPresence(session, node) {
    const to = node.attrs.to;
    if (to && to.toLowerCase().includes(`@${mucDomain}`)) return onRoomPresence(session, node, to);
    if (to) {
      node.attrs.from = session.jid;
      for (const t of findByJid(to)) t.send(node);
      return;
    }
    const firstPresence = session.presence === null;
    const unavailable = node.attrs.type === 'unavailable';
    node.attrs.from = session.jid;
    session.presence = unavailable ? null : node;
    broadcastToFriends(session.accountId, node);
    if (firstPresence && !unavailable) sendFriendPresences(session);
  }

  function onMessage(session, node) {
    const to = node.attrs.to;
    if (!to) return;
    const type = node.attrs.type || 'normal';
    if (type === 'groupchat') {
      const room = rooms.get(bare(to).toLowerCase());
      const nick = room?.get(session);
      if (!room || nick === undefined) return;
      for (const [member] of room) {
        member.send(el('message', { ...node.attrs, from: `${bare(to)}/${nick}`, to: member.jid }, node.children));
      }
      return;
    }
    node.attrs.from = session.jid;
    for (const t of findByJid(to)) {
      node.attrs.to = t.jid;
      t.send(node);
    }
  }

  // ---- MUC (party chat rooms used by older builds) ------------------------------------------

  function onRoomPresence(session, node, to) {
    const roomJid = bare(to).toLowerCase();
    const nick = to.includes('/') ? to.slice(to.indexOf('/') + 1) : session.accountId;
    let room = rooms.get(roomJid);
    if (node.attrs.type === 'unavailable') {
      if (!room?.has(session)) return;
      leaveRoom(session, roomJid);
      return;
    }
    if (!room) {
      room = new Map();
      rooms.set(roomJid, room);
    }
    const isNew = !room.has(session);
    room.set(session, nick);
    session.rooms.add(roomJid);
    const mucX = (self) =>
      el('x', { xmlns: NS.mucUser }, [el('item', { nick: self ? nick : undefined, jid: self ? session.jid : undefined, affiliation: 'none', role: 'participant' }), ...(self ? [el('status', { code: '110' })] : [])]);
    if (isNew) {
      for (const [member, memberNick] of room) {
        if (member === session) continue;
        session.send(el('presence', { from: `${bare(to)}/${memberNick}`, to: session.jid }, [...(member.presence?.children || []), el('x', { xmlns: NS.mucUser }, [el('item', { affiliation: 'none', role: 'participant' })])]));
      }
    }
    for (const [member] of room) {
      member.send(el('presence', { from: `${bare(to)}/${nick}`, to: member.jid }, [...node.children.filter((c) => typeof c === 'string' || c.attrs.xmlns !== NS.muc), mucX(member === session)]));
    }
  }

  function leaveRoom(session, roomJid) {
    const room = rooms.get(roomJid);
    if (!room) return;
    const nick = room.get(session);
    for (const [member] of room) {
      member.send(el('presence', { type: 'unavailable', from: `${roomJid}/${nick}`, to: member.jid }, [el('x', { xmlns: NS.mucUser }, [el('item', { affiliation: 'none', role: 'none' })])]));
    }
    room.delete(session);
    session.rooms.delete(roomJid);
    if (!room.size) rooms.delete(roomJid);
  }

  // ---- presence fan-out ---------------------------------------------------------------------

  function broadcastToFriends(accountId, presenceNode) {
    for (const friendId of friendResolver(accountId)) {
      for (const s of sessions.get(friendId) || []) {
        if (!s.resource) continue;
        s.send(el('presence', { ...presenceNode.attrs, to: s.jid }, presenceNode.children));
      }
    }
  }

  function sendFriendPresences(session) {
    for (const friendId of friendResolver(session.accountId)) sendPresenceOf(friendId, session);
  }

  function sendPresenceOf(fromAccountId, toSession) {
    for (const s of sessions.get(fromAccountId) || []) {
      if (s.presence) toSession.send(el('presence', { ...s.presence.attrs, to: toSession.jid }, s.presence.children));
    }
  }

  function attach(session) {
    let set = sessions.get(session.accountId);
    if (!set) {
      set = new Set();
      sessions.set(session.accountId, set);
    }
    const wasOffline = set.size === 0;
    set.add(session);
    xLog.info(`${session.displayName || session.accountId} connected (${session.mode}, resource ${session.resource})`);
    if (wasOffline) events.emit('online', session.accountId);
  }

  function detach(session) {
    for (const roomJid of [...session.rooms]) leaveRoom(session, roomJid);
    const set = sessions.get(session.accountId);
    if (!set || !set.delete(session)) return;
    if (session.presence) {
      broadcastToFriends(session.accountId, el('presence', { type: 'unavailable', from: session.jid }));
    }
    if (!set.size) {
      sessions.delete(session.accountId);
      xLog.info(`${session.displayName || session.accountId} disconnected`);
      events.emit('offline', session.accountId);
    }
  }

  function findByJid(jid) {
    const [local, rest] = String(jid).split('@');
    const resource = rest && rest.includes('/') ? rest.slice(rest.indexOf('/') + 1) : null;
    const set = sessions.get(local);
    if (!set) return [];
    return [...set].filter((s) => s.resource && (!resource || s.resource === resource));
  }

  function bare(jid) {
    const i = jid.indexOf('/');
    return i === -1 ? jid : jid.slice(0, i);
  }

  return {
    events,
    handleWebSocket,
    handleTcp,
    setFriendResolver: (fn) => {
      friendResolver = fn;
    },
    /** Deliver a backend notification (JSON body) to every connection of an account. */
    sendJson(accountId, payload) {
      const body = JSON.stringify(payload);
      let delivered = 0;
      for (const s of sessions.get(accountId) || []) {
        if (!s.resource) continue;
        s.send(el('message', { from: `xmpp-admin@${domain}`, to: s.jid, xmlns: 'jabber:client' }, [el('body', {}, body)]));
        delivered++;
      }
      return delivered;
    },
    /** After a new friendship, exchange current presences both ways. */
    exchangePresence(a, b) {
      for (const s of sessions.get(a) || []) if (s.resource) sendPresenceOf(b, s);
      for (const s of sessions.get(b) || []) if (s.resource) sendPresenceOf(a, s);
    },
    removePresence(a, b) {
      for (const s of sessions.get(a) || []) for (const t of sessions.get(b) || []) if (t.resource && s.resource) t.send(el('presence', { type: 'unavailable', from: s.jid, to: t.jid }));
      for (const s of sessions.get(b) || []) for (const t of sessions.get(a) || []) if (t.resource && s.resource) t.send(el('presence', { type: 'unavailable', from: s.jid, to: t.jid }));
    },
    isOnline: (accountId) => (sessions.get(accountId)?.size || 0) > 0,
    onlineAccounts: () => [...sessions.keys()],
    get connectionCount() {
      let n = 0;
      for (const set of sessions.values()) n += set.size;
      return n;
    },
    closeAll() {
      for (const set of [...sessions.values()]) for (const s of [...set]) s.close('server shutting down');
    },
    timestamp: isoNow,
  };
}
