import { EpicError } from '../errors.js';

/** Per-request context handed to route handlers. */
export class Context {
  constructor(req, res, url, services) {
    this.req = req;
    this.res = res;
    this.method = req.method;
    this.url = url;
    this.path = url.pathname;
    this.searchParams = url.searchParams;
    this.query = Object.fromEntries(url.searchParams);
    this.headers = req.headers;
    this.params = {};
    this.body = {};
    this.rawBody = Buffer.alloc(0);
    this.services = services;
    this.state = {};
    this.auth = null;
    this.sent = false;
    this._version = null;
  }

  get ip() {
    return this.req.socket.remoteAddress || '';
  }

  get isLoopback() {
    const ip = this.ip;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  /**
   * This machine's address as seen by the caller (the interface the request arrived on), e.g.
   * 127.0.0.1 locally or the Radmin/LAN IP for friends. Used in URLs handed back to clients.
   */
  get localHost() {
    const addr = (this.req.socket.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
    return addr === '::1' || addr === '::' || addr === '0.0.0.0' ? '127.0.0.1' : addr;
  }

  get localPort() {
    return this.req.socket.localPort;
  }

  get userAgent() {
    return this.headers['user-agent'] || '';
  }

  /** Parsed Fortnite build info for this request (see versions/buildInfo.js). */
  get version() {
    if (!this._version) this._version = this.services.versions.resolve(this.userAgent);
    return this._version;
  }

  get adapter() {
    return this.version.adapter;
  }

  /**
   * Build to use for profile work on an account. Requests without a Fortnite User-Agent
   * (custom tools, game-server helpers) use the account's last seen build, so they never
   * switch the profile to the fallback build's season.
   */
  buildFor(account) {
    if (this.version.detected || !account?.lastBuild) return this.version;
    return this.services.versions.fromBuildString(account.lastBuild) || this.version;
  }

  queryAll(name) {
    return this.searchParams.getAll(name);
  }

  header(name, value) {
    this.res.setHeader(name, value);
    return this;
  }

  json(data, status = 200) {
    return this.send(JSON.stringify(data), 'application/json', status);
  }

  text(text, status = 200, type = 'text/plain') {
    return this.send(String(text), type, status);
  }

  noContent(status = 204) {
    this.sent = true;
    this.res.statusCode = status;
    this.res.end();
  }

  send(body, contentType, status = 200) {
    this.sent = true;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.res.statusCode = status;
    this.res.setHeader('Content-Type', contentType);
    this.res.setHeader('Content-Length', buf.length);
    this.res.end(this.method === 'HEAD' ? undefined : buf);
  }

  error(err) {
    if (!(err instanceof EpicError)) throw err;
    this.header('X-Epic-Error-Name', err.errorCode).header('X-Epic-Error-Code', String(err.numericErrorCode));
    this.json(err.toJSON(), err.status);
  }
}
