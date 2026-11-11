import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createApp } from './app.js';
import { ListenError, startServer } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  let config;
  try {
    config = loadConfig({ argv: process.argv.slice(2), env: process.env, rootDir: ROOT, writeDefaultFile: true });
  } catch (err) {
    process.stderr.write(`\n[Gallium] ${err instanceof ConfigError ? err.message : err.stack}\n\n`);
    process.exit(1);
  }

  const log = createLogger(config.logging);
  log.info('Gallium Backend starting');
  log.info(`Config: ${path.relative(ROOT, config.configPath) || config.configPath} | Database: ${config.database.path}`);

  let app;
  let server;
  try {
    app = createApp({ config, log });
    server = await startServer({ config, log, app });
  } catch (err) {
    if (err instanceof ListenError) log.error(err.message);
    else log.error('Startup failed:', err);
    app?.close();
    await log.close();
    process.exit(1);
  }

  const base = `http://${config.server.host}:${server.address.port}`;
  log.info(`Listening on ${base} (HTTP, WebSocket XMPP and matchmaking${config.server.sniffXmppOnHttpPort ? ', raw XMPP' : ''})`);
  if (server.xmppAddress) log.info(`XMPP listening on ${config.server.host}:${server.xmppAddress.port} (raw TCP and ws://)`);
  log.info(`Version adapters: ${app.services.versions.adapters.map((a) => a.id).join(', ')} | accounts: ${app.services.accounts.count()}`);
  log.info(`Health check: ${base}/gallium/api/health  -  press Ctrl+C to stop`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down...`);
    try {
      await server.close();
      app.close();
      log.info('Shutdown complete');
    } catch (err) {
      log.error('Error during shutdown:', err);
    }
    await log.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
  process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection:', err));
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception (shutting down):', err);
    shutdown('uncaughtException');
  });
}

main();
