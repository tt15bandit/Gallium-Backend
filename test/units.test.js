import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseXml, serialize, el, XmlStreamSplitter } from '../src/core/xml.js';
import { Router } from '../src/core/http/router.js';
import { acceptWebSocket, connectWebSocket } from '../src/core/http/websocket.js';
import { loadConfig, ConfigError } from '../src/core/config.js';
import { parseBuild } from '../src/versions/buildInfo.js';
import { createVersionService } from '../src/versions/index.js';
import { makeDataDir } from './helpers.js';

test('xml: parses attributes, entities, nesting and self-closing tags', () => {
  const n = parseXml(`<?xml version='1.0'?><message to="a@b/c" type='chat'><body>{"x":"&lt;1&amp;2&gt;"}</body><x xmlns="y"/></message>`);
  assert.equal(n.name, 'message');
  assert.equal(n.attrs.type, 'chat');
  assert.equal(n.childText('body'), '{"x":"<1&2>"}');
  assert.equal(n.child('x').attrs.xmlns, 'y');
  assert.equal(serialize(el('a', { q: '"<>' }, 'x&y')), '<a q="&quot;&lt;&gt;">x&amp;y</a>');
  assert.throws(() => parseXml('<a><b></a>'));
});

test('xml: stream splitter handles partial chunks, restarts and keep-alives', () => {
  const s = new XmlStreamSplitter();
  const events = [];
  const feed = (t) => events.push(...s.push(t));
  feed("<?xml version='1.0'?><stream:stream xmlns='jabber:client'><auth mech");
  feed("anism='PLAIN'>AAAA</auth>  ");
  feed("<stream:stream xmlns='jabber:client'>"); // restart after SASL
  feed('<iq id="1" type="set"><bind xmlns="b"><resource>R</resource></bind></iq><presence/>');
  feed('</stream:stream>');
  assert.deepEqual(events.map((e) => e.type), ['open', 'stanza', 'open', 'stanza', 'stanza', 'close']);
  assert.equal(parseXml(events[1].xml).text, 'AAAA');
  assert.equal(parseXml(events[3].xml).child('bind').childText('resource'), 'R');
});

test('router: params, wildcard, case-insensitive literals and method mismatch', () => {
  const r = new Router();
  r.get('/a/:id/b', () => 'x');
  r.post('/rest/*', () => 'y');
  assert.deepEqual(r.match('GET', '/A/123/B').params, { id: '123' });
  assert.equal(r.match('POST', '/rest/x/y/z').params['*'], 'x/y/z');
  assert.deepEqual(r.match('POST', '/a/1/b'), { methodMismatch: true });
  assert.equal(r.match('GET', '/nope'), null);
});

test('websocket: handshake, fragmented and large frames, ping/pong, close', async () => {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head, { protocol: 'xmpp' });
    ws.on('message', (m) => ws.send(typeof m === 'string' ? `echo:${m}` : m));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = await connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, { protocols: ['xmpp'] });
  assert.equal(ws.protocol, 'xmpp');
  const next = () => new Promise((r) => ws.once('message', r));
  ws.send('hi');
  assert.equal(await next(), 'echo:hi');
  const big = 'x'.repeat(70000); // 64-bit length frame
  ws.send(big);
  assert.equal((await next()).length, big.length + 5);
  // Hand-made fragmented text frame ("ab" + "cd"), masked as a client must.
  const frame = (fin, op, text) => {
    const p = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]);
  };
  ws.socket.write(Buffer.concat([frame(false, 1, 'ab'), frame(true, 0, 'cd')]));
  assert.equal(await next(), 'echo:abcd');
  const pong = new Promise((r) => ws.once('pong', r));
  ws.ping();
  await pong;
  const closed = new Promise((r) => ws.once('close', r));
  ws.close(1000, 'bye');
  await closed;
  server.close();
});

test('config: defaults, overrides, CLI flags and validation', () => {
  const dir = makeDataDir();
  const c = loadConfig({ rootDir: dir, argv: ['--port', '4000', '--host=0.0.0.0'] });
  assert.equal(c.server.port, 4000);
  assert.equal(c.server.host, '0.0.0.0');
  assert.equal(loadConfig({ rootDir: dir }).server.port, 1523);
  assert.equal(loadConfig({ rootDir: dir }).server.host, '127.0.0.1');
  assert.throws(() => loadConfig({ rootDir: dir, argv: ['--port', '99999'] }), ConfigError);
  assert.throws(() => loadConfig({ rootDir: dir, overrides: { logging: { level: 'loud' } } }), ConfigError);
  assert.throws(() => loadConfig({ rootDir: dir, argv: ['--config', 'missing.json'] }), ConfigError);
});

test('build parsing and adapter selection', () => {
  const cases = [
    ['Fortnite/++Fortnite+Release-Cert-CL-3741772 Windows/10', 1, 'season1-3'],
    ['game=Fortnite, engine=UE4, build=++Fortnite+Release-3.1-CL-3915963, netver=3915963', 3, 'season1-3'],
    ['Fortnite/++Fortnite+Release-3.5-CL-4008490 Windows/10', 3, 'chapter1'],
    ['Fortnite/++Fortnite+Release-4.5-CL-4166199 Windows/10', 4, 'chapter1'],
    ['Fortnite/++Fortnite+Release-10.40-CL-9380822 Windows/10', 10, 'chapter1'],
    ['Fortnite/++Fortnite+Release-11.31-CL-10800459 Windows/10', 11, 'chapter2-4'],
    ['Fortnite/++Fortnite+Release-27.11-CL-29739262 Windows/10', 27, 'chapter2-4'],
    ['Fortnite/++Fortnite+Release-32.00-CL-37770125 Windows/10', 32, 'chapter5plus'],
  ];
  const versions = createVersionService({ config: loadConfig({ rootDir: makeDataDir() }) });
  for (const [ua, season, adapter] of cases) {
    const v = versions.resolve(ua);
    assert.equal(v.season, season, ua);
    assert.equal(v.adapter.id, adapter, ua);
    assert.equal(v.detected, true);
  }
  assert.equal(parseBuild('Fortnite/++Fortnite+Release-1.11-CL-3807424').season, 2);
  assert.equal(parseBuild('curl/8.0'), null);
  const fb = versions.resolve('curl/8.0');
  assert.equal(fb.detected, false);
  assert.equal(fb.season, 10);
  assert.equal(versions.resolve(cases[3][0]).features.cosmeticLocker, false);
  assert.equal(versions.resolve('Release-7.40-CL-5046157').features.cosmeticLocker, true);
  assert.equal(versions.resolve(cases[7][0]).features.lockerService, true);
});
