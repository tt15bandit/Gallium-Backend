import crypto from 'node:crypto';
import { Errors } from '../core/errors.js';
import { hexId, isoNow, safeEqual, sha256Hex } from '../core/util.js';

// Fortnite's public PC game client id (seen in client logs); used when no Basic auth is sent.
export const FORTNITE_CLIENT_ID = 'ec684b8c687f479fadea3cb2ad83f5c6';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * OAuth sessions. Tokens are "eg1~" + an HS256 JWT signed with a per-install secret; the
 * token id (jti) is also stored in SQLite so sessions can be listed, killed, and survive
 * restarts.
 */
export function createAuthService({ repos, config, log }) {
  const aLog = log.child('auth');
  let secret = repos.settings.get('token_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('base64');
    repos.settings.set('token_secret', secret);
  }

  function sign(payload) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'gallium' }));
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `eg1~${header}.${body}.${sig}`;
  }

  function decode(token) {
    if (typeof token !== 'string') return null;
    const raw = token.replace(/^bearer\s+/i, '').replace(/^eg1~/, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!safeEqual(expected, parts[2])) return null;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  /** Parse "Authorization: basic base64(clientId:secret)". */
  function parseClient(header) {
    const m = /^basic\s+(.+)$/i.exec(header || '');
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const clientId = idx === -1 ? decoded : decoded.slice(0, idx);
    if (!/^[A-Za-z0-9_\-]{8,64}$/.test(clientId)) return null;
    return { clientId, clientSecret: idx === -1 ? '' : decoded.slice(idx + 1) };
  }

  function makeToken(kind, { account, clientId, sessionId, authMethod, deviceId, ttlSeconds }) {
    const now = Date.now();
    const jti = hexId();
    const expiresAt = now + ttlSeconds * 1000;
    repos.tokens.insert({ id: jti, kind, accountId: account?.id ?? null, clientId, sessionId, authMethod, deviceId, createdAt: isoNow(), expiresAt });
    const token = sign({
      jti,
      t: kind === 'access' ? 's' : 'r',
      sub: account?.id,
      dn: account?.displayName,
      clid: clientId,
      am: authMethod,
      dvid: deviceId,
      clsvc: 'fortnite',
      ic: true,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAt / 1000),
    });
    return { token, jti, expiresAt };
  }

  /** Issue an access (+ refresh) token pair for an account, or a client token when account is null. */
  function issue({ account = null, clientId, authMethod, deviceId = null }) {
    const sessionId = hexId();
    const dvid = account ? deviceId || sha256Hex(`${account.id}:${clientId}`).slice(0, 32) : null;
    const ttl = config.auth.accessTokenTtlSeconds;
    const access = makeToken('access', { account, clientId, sessionId, authMethod, deviceId: dvid, ttlSeconds: account ? ttl : Math.min(ttl, 4 * 3600) });
    const refresh = account ? makeToken('refresh', { account, clientId, sessionId, authMethod, deviceId: dvid, ttlSeconds: config.auth.refreshTokenTtlSeconds }) : null;
    return { sessionId, access, refresh, deviceId: dvid, clientId, authMethod, account };
  }

  function tokenResponse(issued) {
    const { access, refresh, account, clientId } = issued;
    const res = {
      access_token: access.token,
      expires_in: Math.round((access.expiresAt - Date.now()) / 1000),
      expires_at: new Date(access.expiresAt).toISOString(),
      token_type: 'bearer',
    };
    if (account) {
      Object.assign(res, {
        refresh_token: refresh.token,
        refresh_expires: Math.round((refresh.expiresAt - Date.now()) / 1000),
        refresh_expires_at: new Date(refresh.expiresAt).toISOString(),
        account_id: account.id,
        client_id: clientId,
        internal_client: true,
        client_service: 'fortnite',
        displayName: account.displayName,
        app: 'fortnite',
        in_app_id: account.id,
        device_id: issued.deviceId,
        product_id: 'prod-fn',
      });
    } else {
      Object.assign(res, { client_id: clientId, internal_client: true, client_service: 'fortnite', product_id: 'prod-fn' });
    }
    return res;
  }

  function lookup(token, kind) {
    const payload = decode(token);
    if (!payload?.jti) return null;
    const row = repos.tokens.byId(payload.jti);
    if (!row || row.kind !== kind || row.expiresAt <= Date.now()) return null;
    const account = row.accountId ? repos.accounts.byId(row.accountId) : null;
    if (row.accountId && (!account || account.banned)) return null;
    return { ...row, account, token: String(token).replace(/^bearer\s+/i, '') };
  }

  return {
    parseClient,
    issue,
    tokenResponse,
    /** Validate an access token; returns the session or throws. */
    verify(token) {
      const s = lookup(token, 'access');
      if (!s) throw Errors.invalidToken(String(token || '').replace(/^bearer\s+/i, '').slice(0, 64));
      return s;
    },
    tryVerify: (token) => lookup(token, 'access'),
    verifyRefresh(token) {
      const s = lookup(token, 'refresh');
      if (!s) throw Errors.refreshTokenInvalid(String(token || '').slice(0, 64));
      return s;
    },
    verifyResponse(s) {
      return {
        token: s.token,
        session_id: s.sessionId,
        token_type: 'bearer',
        client_id: s.clientId,
        internal_client: true,
        client_service: 'fortnite',
        account_id: s.accountId ?? undefined,
        expires_in: Math.round((s.expiresAt - Date.now()) / 1000),
        expires_at: new Date(s.expiresAt).toISOString(),
        auth_method: s.authMethod,
        display_name: s.account?.displayName,
        app: 'fortnite',
        in_app_id: s.accountId ?? undefined,
        device_id: s.deviceId ?? undefined,
      };
    },
    killSession: (sessionId) => repos.tokens.deleteSession(sessionId),
    killToken(token) {
      const payload = decode(token);
      const row = payload?.jti ? repos.tokens.byId(payload.jti) : null;
      if (row) repos.tokens.deleteSession(row.sessionId);
      return !!row;
    },
    /** killType: OTHERS | ALL | OTHERS_ACCOUNT_CLIENT | OTHERS_ACCOUNT_CLIENT_SERVICE | ALL_ACCOUNT_CLIENT */
    killSessions(session, killType) {
      const { accountId, sessionId, clientId } = session;
      if (!accountId) return 0;
      switch (killType) {
        case 'ALL':
          return repos.tokens.deleteForAccount(accountId, null).changes;
        case 'ALL_ACCOUNT_CLIENT':
          return repos.tokens.deleteForAccountClient(accountId, clientId, null).changes;
        case 'OTHERS_ACCOUNT_CLIENT':
        case 'OTHERS_ACCOUNT_CLIENT_SERVICE':
          return repos.tokens.deleteForAccountClient(accountId, clientId, sessionId).changes;
        case 'OTHERS':
        default:
          return repos.tokens.deleteForAccount(accountId, sessionId).changes;
      }
    },
    createExchangeCode(accountId, clientId) {
      const code = hexId();
      repos.exchangeCodes.insert({ code, accountId, clientId, expiresAt: Date.now() + config.auth.exchangeCodeTtlSeconds * 1000 });
      return { code, expiresInSeconds: config.auth.exchangeCodeTtlSeconds, creatingClientId: clientId };
    },
    consumeExchangeCode(code) {
      if (typeof code !== 'string' || !code) throw Errors.invalidRequest('exchange_code is required');
      const row = repos.exchangeCodes.consume(code);
      if (!row || row.expiresAt <= Date.now()) throw Errors.exchangeCodeNotFound();
      return row;
    },
    createDeviceAuth(accountId, userAgent, ip) {
      const deviceId = hexId();
      const secretValue = crypto.randomBytes(24).toString('hex');
      const created = isoNow();
      repos.deviceAuths.insert({ deviceId, accountId, secretHash: sha256Hex(secretValue), userAgent: userAgent || '', createdAt: created });
      return { deviceId, accountId, secret: secretValue, userAgent: userAgent || '', created: { location: 'Local', ipAddress: ip || '127.0.0.1', dateTime: created } };
    },
    verifyDeviceAuth(accountId, deviceId, secretValue) {
      const d = repos.deviceAuths.byId(String(deviceId || ''));
      if (!d || d.accountId !== accountId || !safeEqual(d.secretHash, sha256Hex(String(secretValue || '')))) throw Errors.deviceAuthInvalid();
      return d;
    },
    listDeviceAuths: (accountId) => repos.deviceAuths.forAccount(accountId),
    deleteDeviceAuth: (accountId, deviceId) => repos.deviceAuths.delete(accountId, deviceId),
    pruneExpired() {
      const now = Date.now();
      const n = repos.tokens.pruneExpired(now) + repos.exchangeCodes.pruneExpired(now);
      if (n) aLog.debug(`Pruned ${n} expired tokens/codes`);
      return n;
    },
  };
}
