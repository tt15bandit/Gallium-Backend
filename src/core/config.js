import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './util.js';

/**
 * The single source of truth for configuration defaults. A gallium.config.json next to the
 * project (or the file passed with --config) is deep-merged over this, then environment
 * variables, then command-line flags.
 */
export const DEFAULT_CONFIG = Object.freeze({
  server: {
    host: '127.0.0.1',
    port: 1523,
    bodyLimitBytes: 8 * 1024 * 1024,
    // Accept raw-TCP XMPP on the HTTP port too (Fortnite 3.x/4.x point XMPP at the backend port).
    sniffXmppOnHttpPort: true,
  },
  xmpp: {
    enabled: true,
    // Extra listener for XMPP (raw TCP and WebSocket). 5.x-21.x hotfixes commonly use ws://127.0.0.1:5222.
    port: 5222,
    // Address put in the XMPP hotfix. null = the address each client used to reach Gallium
    // (127.0.0.1 locally, your Radmin/LAN IP for friends).
    advertiseHost: null,
    domain: 'prod.ol.epicgames.com',
    mucDomain: 'muc.prod.ol.epicgames.com',
  },
  logging: { level: 'info', requests: true, file: 'logs/gallium.log' },
  database: { path: 'data/gallium.db' },
  accounts: {
    autoRegister: true,
    startingVbucks: 1000,
    grantAllCosmetics: false,
    grantMfaReward: true,
  },
  auth: { accessTokenTtlSeconds: 8 * 3600, refreshTokenTtlSeconds: 24 * 3600, exchangeCodeTtlSeconds: 300 },
  versions: {
    // Used when a request carries no recognisable Fortnite User-Agent.
    fallbackBuild: '++Fortnite+Release-10.40-CL-9380822',
    // Force every request to be treated as this build (e.g. "++Fortnite+Release-4.5-CL-4166199").
    forceBuild: null,
  },
  matchmaking: {
    // WebSocket URL handed to clients in matchmaking tickets. null = ws://<host>:<port>/matchmaking
    serviceUrl: null,
    defaultRegion: 'NAE',
    // { "address": "127.0.0.1", "port": 7777 } used when no game server has registered.
    fallbackServer: null,
    ticketTtlSeconds: 600,
  },
  gameServers: {
    // Key game servers send as "Authorization: Bearer <key>". null = only loopback callers allowed.
    apiKey: null,
    heartbeatTimeoutSeconds: 90,
  },
  admin: { apiKey: null },
  data: { dir: 'data' },
});

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = 'true';
  }
  return out;
}

function deepMerge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not read config file ${file}: ${err.message}`);
  }
}

export class ConfigError extends Error {}

/**
 * @param {object} opts
 * @param {string[]} [opts.argv]   process.argv.slice(2)
 * @param {object}   [opts.env]    process.env
 * @param {string}   [opts.rootDir] base directory for relative paths
 * @param {object}   [opts.overrides] programmatic overrides (used by tests)
 * @param {boolean}  [opts.writeDefaultFile] create gallium.config.json if missing
 */
export function loadConfig({ argv = [], env = {}, rootDir = process.cwd(), overrides = null, writeDefaultFile = false } = {}) {
  const args = parseArgs(argv);
  let config = structuredClone(DEFAULT_CONFIG);

  const configPath = path.resolve(rootDir, args.config || env.GALLIUM_CONFIG || 'gallium.config.json');
  if (fs.existsSync(configPath)) {
    config = deepMerge(config, readJsonFile(configPath));
  } else if (args.config || env.GALLIUM_CONFIG) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  } else if (writeDefaultFile) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }

  if (overrides) config = deepMerge(config, overrides);

  const host = args.host || env.GALLIUM_HOST;
  const port = args.port || env.GALLIUM_PORT;
  if (host) config.server.host = host;
  if (port !== undefined) config.server.port = Number(port);
  if (args['xmpp-port'] || env.GALLIUM_XMPP_PORT) config.xmpp.port = Number(args['xmpp-port'] || env.GALLIUM_XMPP_PORT);
  if (args.db || env.GALLIUM_DB) config.database.path = args.db || env.GALLIUM_DB;
  if (args['log-level'] || env.GALLIUM_LOG_LEVEL) config.logging.level = args['log-level'] || env.GALLIUM_LOG_LEVEL;
  if (args.build || env.GALLIUM_FORCE_BUILD) config.versions.forceBuild = args.build || env.GALLIUM_FORCE_BUILD;

  validate(config);

  const resolve = (p) => (p === ':memory:' || path.isAbsolute(p) ? p : path.resolve(rootDir, p));
  config.rootDir = rootDir;
  config.configPath = configPath;
  config.database.path = resolve(config.database.path);
  config.data.dir = resolve(config.data.dir);
  if (config.logging.file) config.logging.file = resolve(config.logging.file);
  return config;
}

function validate(c) {
  const problems = [];
  const isPort = (p, allowZero) => Number.isInteger(p) && p >= (allowZero ? 0 : 1) && p <= 65535;
  if (typeof c.server.host !== 'string' || !c.server.host) problems.push('server.host must be a non-empty string');
  if (!isPort(c.server.port, true)) problems.push(`server.port must be an integer 0-65535 (got ${c.server.port})`);
  if (c.xmpp.enabled && !isPort(c.xmpp.port, true)) problems.push(`xmpp.port must be an integer 0-65535 (got ${c.xmpp.port})`);
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(c.logging.level)) problems.push(`logging.level must be debug|info|warn|error|silent`);
  if (!Number.isInteger(c.accounts.startingVbucks) || c.accounts.startingVbucks < 0) problems.push('accounts.startingVbucks must be a non-negative integer');
  for (const k of ['accessTokenTtlSeconds', 'refreshTokenTtlSeconds', 'exchangeCodeTtlSeconds']) {
    if (!Number.isInteger(c.auth[k]) || c.auth[k] <= 0) problems.push(`auth.${k} must be a positive integer`);
  }
  const fb = c.matchmaking.fallbackServer;
  if (fb !== null && (typeof fb !== 'object' || typeof fb.address !== 'string' || !isPort(fb.port))) {
    problems.push('matchmaking.fallbackServer must be null or { "address": string, "port": number }');
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}
