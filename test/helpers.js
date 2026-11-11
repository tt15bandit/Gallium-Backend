import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { connectWebSocket } from '../src/core/http/websocket.js';
import { parseXml, XmlStreamSplitter } from '../src/core/xml.js';

export const UA = {
  cert: 'Fortnite/++Fortnite+Release-Cert-CL-3741772 Windows/10.0.19041.1.256.64bit',
  v3_1: 'Fortnite/++Fortnite+Release-3.1-CL-3915963 Windows/10.0.19041.1.256.64bit',
  v4_5: 'Fortnite/++Fortnite+Release-4.5-CL-4166199 Windows/10.0.19041.1.256.64bit',
  v5_41: 'Fortnite/++Fortnite+Release-5.41-CL-4363240 Windows/10.0.19041.1.256.64bit',
  v14_60: 'Fortnite/++Fortnite+Release-14.60-CL-14786821 Windows/10.0.19041.1.256.64bit',
  v21_50: 'Fortnite/++Fortnite+Release-21.50-CL-21657658 Windows/10.0.19041.1.256.64bit',
  v32_00: 'Fortnite/++Fortnite+Release-32.00-CL-37770125 Windows/10.0.26100.1.256.64bit',
  v37_20: 'Fortnite/++Fortnite+Release-37.20-CL-45566402 Windows/10.0.26100.1.256.64bit',
};

export const FN_CLIENT = 'Basic ' + Buffer.from('ec684b8c687f479fadea3cb2ad83f5c6:e1f31c211f28413186262d37a13fc84d').toString('base64');

/** Make a fresh data directory, optionally pre-populated with data files. */
export function makeDataDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallium-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  return dir;
}

/**
 * Start a Gallium instance on random ports. Pass the same `dataDir` to a second call to
 * simulate a restart against the same database.
 */
export async function startGallium({ dataDir = makeDataDir(), overrides = {}, partyDisconnectGraceMs = 30000 } = {}) {
  const config = loadConfig({
    rootDir: dataDir,
    overrides: {
      server: { port: 0 },
      xmpp: { port: 0 },
      logging: { level: process.env.GALLIUM_TEST_LOG || 'silent', file: null, requests: false },
      database: { path: path.join(dataDir, 'gallium.db') },
      data: { dir: dataDir },
      ...overrides,
    },
  });
  const log = createLogger({ level: config.logging.level, file: null, colors: false });
  const app = createApp({ config, log, partyDisconnectGraceMs });
  const server = await startServer({ config, log, app });
  config.server.port = server.address.port;
  const base = `http://127.0.0.1:${server.address.port}`;
  return {
    base,
    port: server.address.port,
    xmppPort: server.xmppAddress?.port,
    app,
    services: app.services,
    dataDir,
    async stop() {
      await server.close();
      app.close();
    },
  };
}

export async function call(base, method, urlPath, { token, body, form, ua = UA.v14_60, headers = {}, raw } = {}) {
  const h = { 'User-Agent': ua, ...headers };
  if (token) h.Authorization = `bearer ${token}`;
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (raw !== undefined) {
    h['Content-Type'] = h['Content-Type'] || 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + urlPath, { method, headers: h, body: payload });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  let json = null;
  if ((res.headers.get('content-type') || '').includes('json') && text) json = JSON.parse(text);
  return { status: res.status, headers: res.headers, json, text, buffer };
}

export async function login(base, username, password = 'Rebooted', ua = UA.v14_60) {
  const r = await call(base, 'POST', '/account/api/oauth/token', { ua, headers: { Authorization: FN_CLIENT }, form: { grant_type: 'password', username, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return { token: r.json.access_token, accountId: r.json.account_id, refresh: r.json.refresh_token, displayName: r.json.displayName, raw: r.json };
}

/** POST an MCP command and return the parsed response. */
export async function mcp(base, session, command, profileId, body = {}, { ua = UA.v14_60, rvn = -1, route = 'client', accountId = session.accountId, extraQuery = '' } = {}) {
  return call(base, 'POST', `/fortnite/api/game/v2/profile/${accountId}/${route}/${command}?profileId=${profileId}&rvn=${rvn}${extraQuery}`, { token: session.token, ua, body });
}

export function profileOf(res) {
  const change = res.json.profileChanges.find((c) => c.changeType === 'fullProfileUpdate');
  return change?.profile;
}

/** Collects parsed XMPP stanzas and lets tests await specific ones. */
class StanzaInbox {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  push(node) {
    this.items.push(node);
    for (const w of [...this.waiters]) {
      const i = this.items.findIndex(w.pred);
      if (i !== -1) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.items.splice(i, 1)[0]);
      }
    }
  }

  wait(pred, timeoutMs = 3000, label = 'stanza') {
    const i = this.items.findIndex(pred);
    if (i !== -1) return Promise.resolve(this.items.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for ${label}`));
        }
      }, timeoutMs).unref();
    });
  }

  /** Wait for a backend JSON notification of the given type. */
  json(type, pred = () => true, timeoutMs = 3000) {
    const match = (n) => {
      if (n.local !== 'message' || !n.childText('body') || safeType(n.childText('body')) !== type) return false;
      return pred(JSON.parse(n.childText('body')));
    };
    return this.wait(match, timeoutMs, `notification ${type}`).then((n) => JSON.parse(n.childText('body')));
  }
}

function safeType(text) {
  try {
    return JSON.parse(text).type;
  } catch {
    return null;
  }
}

/** XMPP client over WebSocket with RFC 7395 framing (like Fortnite 32.00). */
export async function xmppWs(port, session, { resource = 'V2:Fortnite:WIN::TEST', path: p = '/' } = {}) {
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}${p}`, { protocols: ['xmpp'] });
  const inbox = new StanzaInbox();
  ws.on('message', (t) => inbox.push(parseXml(String(t))));
  const send = (x) => ws.send(x);
  const open = '<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>';
  send(open);
  await inbox.wait((n) => n.local === 'features');
  send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${Buffer.from(`\0${session.accountId}\0${session.token}`).toString('base64')}</auth>`);
  const result = await inbox.wait((n) => n.local === 'success' || n.local === 'failure');
  if (result.local === 'failure') return { ws, inbox, failed: true };
  send(open);
  await inbox.wait((n) => n.local === 'features' && n.child('bind'));
  send(`<iq id="_xmpp_bind1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${resource}</resource></bind></iq>`);
  const bound = await inbox.wait((n) => n.local === 'iq' && n.attrs.id === '_xmpp_bind1');
  send('<iq id="_xmpp_session1" type="set"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>');
  await inbox.wait((n) => n.local === 'iq' && n.attrs.id === '_xmpp_session1');
  return { ws, inbox, send, jid: bound.child('bind').childText('jid'), close: () => ws.close() };
}

/** XMPP client over raw TCP with a classic <stream:stream> (like Fortnite 3.1 / 4.5). */
export async function xmppTcp(port, session, { resource = 'V2:Fortnite:WIN::TCP' } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => socket.once('connect', r).once('error', j));
  const inbox = new StanzaInbox();
  const splitter = new XmlStreamSplitter();
  socket.setEncoding('utf8');
  socket.on('data', (d) => {
    for (const ev of splitter.push(d)) if (ev.type === 'stanza') inbox.push(parseXml(ev.xml));
  });
  const send = (x) => socket.write(x);
  const header = '<?xml version="1.0"?><stream:stream to="prod.ol.epicgames.com" xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams" version="1.0">';
  send(header);
  await inbox.wait((n) => n.local === 'features');
  send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${Buffer.from(`\0${session.accountId}\0${session.token}`).toString('base64')}</auth>`);
  const result = await inbox.wait((n) => n.local === 'success' || n.local === 'failure');
  if (result.local === 'failure') return { socket, inbox, failed: true };
  send(header); // stream restart after SASL
  await inbox.wait((n) => n.local === 'features' && n.child('bind'));
  send(`<iq id="b1" type="set"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${resource}</resource></bind></iq>`);
  const bound = await inbox.wait((n) => n.local === 'iq' && n.attrs.id === 'b1');
  return { socket, inbox, send, jid: bound.child('bind').childText('jid'), close: () => socket.end() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
