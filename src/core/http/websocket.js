import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

/** RFC 6455 WebSocket implementation (server accept + client connect), used by XMPP and matchmaking. */
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function isWebSocketUpgrade(req) {
  return (req.headers.upgrade || '').toLowerCase() === 'websocket';
}

export function requestedProtocols(req) {
  return (req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
}

export function rejectUpgrade(socket, status, reason) {
  const body = reason || http.STATUS_CODES[status] || '';
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function acceptWebSocket(req, socket, head, { protocol = null, maxMessageBytes } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'Invalid WebSocket handshake');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const ws = new WebSocketConnection(socket, { client: false, maxMessageBytes });
  if (head && head.length) ws._onData(head);
  return ws;
}

/** Client-side connect (used by the test-suite and tooling). */
export function connectWebSocket(url, { headers = {}, protocols = [], timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('Invalid Sec-WebSocket-Accept from server'));
        return;
      }
      const ws = new WebSocketConnection(socket, { client: true });
      ws.protocol = res.headers['sec-websocket-protocol'] || null;
      resolve(ws);
      // Frames that arrived together with the 101 response are parsed on the next tick, after
      // the caller has had a chance to attach its 'message' listener.
      if (head && head.length) setImmediate(() => ws._onData(head));
    });
    req.on('response', (res) => {
      const err = new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`);
      err.status = res.statusCode;
      res.resume();
      reject(err);
    });
    req.on('timeout', () => req.destroy(new Error('WebSocket connect timeout')));
    req.on('error', reject);
    req.end();
  });
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { client, maxMessageBytes = 16 * 1024 * 1024 }) {
    super();
    this.socket = socket;
    this.client = client;
    this.maxMessageBytes = maxMessageBytes;
    this.state = 'open';
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish(1006, ''));
    socket.on('error', (err) => {
      if (this.listenerCount('error')) this.emit('error', err);
    });
  }

  get remoteAddress() {
    return this.socket.remoteAddress;
  }

  send(data) {
    if (this.state !== 'open') return false;
    const isText = typeof data === 'string';
    this._sendFrame(isText ? OP.TEXT : OP.BINARY, isText ? Buffer.from(data, 'utf8') : data);
    return true;
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.state === 'open') this._sendFrame(OP.PING, payload);
  }

  close(code = 1000, reason = '') {
    if (this.state !== 'open') return;
    this.state = 'closing';
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(OP.CLOSE, payload);
    // Give the peer a moment to answer, then drop the TCP connection.
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  terminate() {
    this.socket.destroy();
  }

  _finish(code, reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', code, reason);
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    if (this.client) {
      header[1] |= 0x80;
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      this.socket.write(Buffer.concat([header, mask, masked]));
    } else {
      this.socket.write(Buffer.concat([header, payload]));
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.state !== 'closed') {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) {
        this._protocolError(1009, 'Message too big');
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > this.maxMessageBytes) {
      this._protocolError(1009, 'Message too big');
      return null;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this.buffer = buf.subarray(offset + maskLen + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.TEXT:
      case OP.BINARY:
        if (fin) this._emitMessage(opcode, payload);
        else {
          this.fragments = [payload];
          this.fragmentOpcode = opcode;
        }
        break;
      case OP.CONT:
        if (!this.fragments) return this._protocolError(1002, 'Unexpected continuation frame');
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = null;
          this._emitMessage(this.fragmentOpcode, full);
        }
        break;
      case OP.PING:
        if (this.state === 'open') this._sendFrame(OP.PONG, payload);
        break;
      case OP.PONG:
        this.emit('pong');
        break;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.state === 'open') {
          this.state = 'closing';
          this._sendFrame(OP.CLOSE, payload.subarray(0, 2));
        }
        this.socket.end();
        this._finish(code, reason);
        break;
      }
      default:
        this._protocolError(1002, `Unknown opcode ${opcode}`);
    }
  }

  _emitMessage(opcode, payload) {
    this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload, opcode === OP.BINARY);
  }

  _protocolError(code, reason) {
    this.close(code, reason);
    this.buffer = Buffer.alloc(0);
  }
}
