import http from 'node:http';
import net from 'node:net';
import { createRequestHandler } from './core/http/handler.js';
import { acceptWebSocket, isWebSocketUpgrade, rejectUpgrade, requestedProtocols } from './core/http/websocket.js';

export class ListenError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Starts the network listeners:
 *   - main port (default 127.0.0.1:1523): HTTP API, WebSocket upgrades (XMPP + matchmaking),
 *     and raw-TCP XMPP detected from the first byte ('<').
 *   - XMPP port (default 5222): the same protocol sniffing, for hotfixes that point XMPP there.
 */
export async function startServer({ config, log, app }) {
  const { services } = app;
  const sLog = log.child('server');
  const handler = createRequestHandler({ router: app.router, services, config, log });
  const httpServer = http.createServer(handler);
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 70000;
  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  httpServer.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    if (!isWebSocketUpgrade(req)) return rejectUpgrade(socket, 400, 'Expected a WebSocket upgrade');
    const path = new URL(req.url, 'http://gallium.local').pathname.toLowerCase();
    const authHeader = req.headers.authorization || '';
    if (path.startsWith('/matchmaking') || /^epic-signed/i.test(authHeader)) {
      const ticket = services.matchmaking.verifyAuthorization(authHeader);
      if (!ticket) return rejectUpgrade(socket, 401, 'Invalid or expired matchmaking ticket');
      const ws = acceptWebSocket(req, socket, head);
      if (ws) services.matchmaking.handleConnection(ws, ticket);
      return;
    }
    if (!config.xmpp.enabled) return rejectUpgrade(socket, 404, 'XMPP is disabled');
    const ws = acceptWebSocket(req, socket, head, { protocol: requestedProtocols(req).includes('xmpp') ? 'xmpp' : null });
    if (ws) services.xmpp.handleWebSocket(ws);
  }

  const sockets = new Set();
  let warnedTls = false;
  function onConnection(socket, allowRawXmpp) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      if (chunk[0] === 0x16) {
        if (!warnedTls) {
          sLog.warn(`Received a TLS (https) handshake from ${socket.remoteAddress}. Gallium speaks plain HTTP: make sure your redirect sends clients to http://${config.server.host}:${config.server.port}.`);
          warnedTls = true;
        }
        socket.destroy();
        return;
      }
      if (allowRawXmpp && chunk[0] === 0x3c && config.xmpp.enabled) {
        services.xmpp.handleTcp(socket, chunk);
        return;
      }
      socket.pause();
      socket.unshift(chunk);
      httpServer.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  }

  const listen = (server, host, port, label) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') reject(new ListenError(`${label} port ${port} on ${host} is already in use. Stop the other program using it (another backend?) or change the port in gallium.config.json / --port.`, err.code));
        else if (err.code === 'EACCES') reject(new ListenError(`No permission to listen on ${host}:${port} (${label}). Try a port above 1024.`, err.code));
        else if (err.code === 'EADDRNOTAVAIL') reject(new ListenError(`Address ${host} is not available on this machine (${label}).`, err.code));
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  const mainServer = net.createServer((s) => onConnection(s, config.server.sniffXmppOnHttpPort));
  const mainAddress = await listen(mainServer, config.server.host, config.server.port, 'HTTP');

  let xmppServer = null;
  let xmppAddress = null;
  if (config.xmpp.enabled && config.xmpp.port !== mainAddress.port) {
    xmppServer = net.createServer((s) => onConnection(s, true));
    try {
      xmppAddress = await listen(xmppServer, config.server.host, config.xmpp.port, 'XMPP');
    } catch (err) {
      mainServer.close();
      throw err;
    }
  }

  const timers = [
    setInterval(() => services.auth.pruneExpired(), 3600 * 1000),
    setInterval(() => services.gameServers.pruneDead(), 15 * 1000),
  ];
  for (const t of timers) t.unref();
  services.auth.pruneExpired();

  let closing = null;
  return {
    httpServer,
    address: mainAddress,
    xmppAddress,
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => {
        for (const t of timers) clearInterval(t);
        services.xmpp.closeAll();
        services.matchmaking.shutdown();
        let pending = xmppServer ? 2 : 1;
        const done = () => {
          if (--pending === 0) resolve();
        };
        // net.Server.close() resolves once every connection is gone; give in-flight requests
        // a moment, then drop idle keep-alive and socket connections.
        mainServer.close(done);
        xmppServer?.close(done);
        setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, 300).unref();
      });
      return closing;
    },
  };
}
