import { Errors } from '../core/errors.js';
import { FORTNITE_CLIENT_ID } from '../services/auth.js';
import { requireAccount, requireAuth, ownAccount } from './middleware.js';

/** account-public-service: OAuth, sessions, exchange codes, device auths and account lookups. */
export function registerAccountRoutes(router) {
  router.post('/account/api/oauth/token', (ctx) => {
    const { auth, accounts, config } = ctx.services;
    const client = auth.parseClient(ctx.headers.authorization) || { clientId: FORTNITE_CLIENT_ID };
    const body = ctx.body || {};
    const grant = body.grant_type;
    if (typeof grant !== 'string') throw Errors.invalidRequest('grant_type is required');
    const log = ctx.services.log.child('auth');
    const legacy = !!ctx.version.features.legacyTokens;
    let account = null;
    let deviceId = null;

    switch (grant) {
      case 'client_credentials':
        return ctx.json(auth.tokenResponse(auth.issue({ clientId: client.clientId, authMethod: 'client_credentials', legacy })));

      case 'password': {
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!username || !password) throw Errors.invalidRequest('username and password are required');
        account = accounts.findByLogin(username);
        if (!account) {
          if (!config.accounts.autoRegister) throw Errors.invalidCredentials();
          const email = username.includes('@') ? username : null;
          account = accounts.create({ email, displayName: email ? accounts.uniqueNameFrom(email) : accounts.uniqueNameFrom(username), password });
          log.info(`Auto-registered ${account.displayName} on first login`);
        } else if (!accounts.verifyPassword(password, account.passwordHash)) {
          accounts.recordFailedLogin(account);
          throw Errors.invalidCredentials();
        }
        break;
      }

      case 'exchange_code': {
        const code = auth.consumeExchangeCode(body.exchange_code);
        account = accounts.get(code.accountId);
        if (!account) throw Errors.exchangeCodeNotFound();
        break;
      }

      case 'refresh_token': {
        const session = auth.verifyRefresh(body.refresh_token);
        account = session.account;
        deviceId = session.deviceId;
        auth.killSession(session.sessionId);
        break;
      }

      case 'device_auth': {
        const d = auth.verifyDeviceAuth(body.account_id, body.device_id, body.secret);
        account = accounts.get(d.accountId);
        deviceId = d.deviceId;
        break;
      }

      case 'token_to_token':
      case 'external_auth':
      case 'otp':
      case 'authorization_code':
      default:
        throw Errors.unsupportedGrant(grant);
    }

    if (account.banned) throw Errors.accountBanned(account.displayName);
    accounts.recordLogin(account.id, ctx.version.detected ? ctx.version.raw : undefined);
    const issued = auth.issue({ account, clientId: client.clientId, authMethod: grant, deviceId, legacy });
    log.info(`${account.displayName} logged in (${grant}, build ${ctx.version.detected ? ctx.version.raw : 'unknown'}, adapter ${ctx.adapter.id})`);
    ctx.json(auth.tokenResponse(issued));
  });

  router.get('/account/api/oauth/verify', requireAuth, (ctx) => {
    ctx.json(ctx.services.auth.verifyResponse(ctx.auth));
  });

  router.delete('/account/api/oauth/sessions/kill', requireAuth, (ctx) => {
    const killType = ctx.query.killType || 'OTHERS';
    ctx.services.auth.killSessions(ctx.auth, killType);
    ctx.noContent();
  });

  router.delete('/account/api/oauth/sessions/kill/:token', (ctx) => {
    ctx.services.auth.killToken(ctx.params.token);
    ctx.noContent();
  });

  router.get('/account/api/oauth/exchange', requireAccount, (ctx) => {
    ctx.json(ctx.services.auth.createExchangeCode(ctx.auth.accountId, ctx.auth.clientId));
  });

  router.get('/account/api/public/account', requireAuth, (ctx) => {
    const ids = ctx.queryAll('accountId').slice(0, 100);
    ctx.json(ctx.services.accounts.byIds(ids).map((a) => ctx.services.accounts.summary(a)));
  });

  router.get('/account/api/public/account/displayName/:displayName', requireAuth, (ctx) => {
    const a = ctx.services.accounts.byDisplayName(ctx.params.displayName);
    if (!a) throw Errors.accountNotFound(ctx.params.displayName);
    ctx.json(ctx.services.accounts.summary(a));
  });

  router.get('/account/api/public/account/email/:email', requireAuth, (ctx) => {
    const a = ctx.services.accounts.byEmail(ctx.params.email);
    if (!a) throw Errors.accountNotFound(ctx.params.email);
    ctx.json(ctx.services.accounts.summary(a));
  });

  router.get('/account/api/public/account/:accountId', requireAuth, (ctx) => {
    const { accounts } = ctx.services;
    const a = accounts.require(ctx.params.accountId);
    ctx.json(ctx.auth.accountId === a.id ? accounts.publicAccount(a) : accounts.summary(a));
  });

  router.get('/account/api/public/account/:accountId/externalAuths', ownAccount(), (ctx) => ctx.json([]));

  router.get('/account/api/public/account/:accountId/deviceAuth', ownAccount(), (ctx) => {
    ctx.json(ctx.services.auth.listDeviceAuths(ctx.auth.accountId));
  });

  router.post('/account/api/public/account/:accountId/deviceAuth', ownAccount(), (ctx) => {
    ctx.json(ctx.services.auth.createDeviceAuth(ctx.auth.accountId, ctx.userAgent, ctx.ip));
  });

  router.delete('/account/api/public/account/:accountId/deviceAuth/:deviceId', ownAccount(), (ctx) => {
    if (!ctx.services.auth.deleteDeviceAuth(ctx.auth.accountId, ctx.params.deviceId)) throw Errors.notFound(`device auth ${ctx.params.deviceId}`);
    ctx.noContent();
  });

  router.get('/account/api/epicdomains/ssodomains', (ctx) => ctx.json([]));
}
