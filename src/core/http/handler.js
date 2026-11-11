import { Context } from './context.js';
import { EpicError, Errors } from '../errors.js';

/**
 * Builds the Node request listener: parses the URL and body, dispatches through the router,
 * converts thrown EpicErrors into Epic-style JSON responses, and logs each request.
 */
export function createRequestHandler({ router, services, config, log }) {
  const reqLog = log.child('http');
  const bodyLimit = config.server.bodyLimitBytes;
  const logRequests = config.logging.requests;

  return async function handle(req, res) {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, 'http://gallium.local');
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const ctx = new Context(req, res, url, services);
    res.setHeader('X-Powered-By', 'Gallium');

    try {
      const found = router.match(req.method, url.pathname);
      if (!found) throw Errors.notFound(`the resource '${url.pathname}'`);
      if (found.methodMismatch) throw Errors.methodNotAllowed();
      ctx.params = found.params;
      if (req.method !== 'GET' && req.method !== 'HEAD') await readBody(req, ctx, bodyLimit);
      for (const handler of found.route.handlers) {
        await handler(ctx);
        if (ctx.sent) break;
      }
      if (!ctx.sent) ctx.noContent();
    } catch (err) {
      if (err instanceof EpicError) {
        if (!ctx.sent) ctx.error(err);
      } else {
        reqLog.error(`Unhandled error on ${req.method} ${url.pathname}:`, err);
        if (!ctx.sent && !res.headersSent) ctx.error(Errors.internal());
        else res.destroy();
      }
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = `${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${ms.toFixed(1)}ms)`;
      if (res.statusCode === 404 || res.statusCode === 405) reqLog.warn(`${line} [unhandled route, UA: ${ctx.userAgent || 'none'}]`);
      else if (res.statusCode >= 500) reqLog.error(line);
      else if (logRequests) reqLog.info(line);
      else reqLog.debug(line);
    }
  };
}

function readBody(req, ctx, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(Errors.payloadTooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks);
      ctx.rawBody = raw;
      try {
        ctx.body = parseBody(raw, req.headers['content-type'] || '');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseBody(raw, contentType) {
  if (raw.length === 0) return {};
  const type = contentType.toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  const looksJson = type.includes('json') || (!type.includes('octet-stream') && /^\s*[{[]/.test(raw.subarray(0, 16).toString('utf8')));
  if (looksJson) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw Errors.validation('Request body is not valid JSON');
    }
  }
  return {};
}
