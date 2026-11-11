import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

/**
 * Small leveled logger. One root logger writes to the console (and optionally a file);
 * child loggers only add a scope prefix.
 */
export function createLogger({ level = 'info', file = null, colors = process.stdout.isTTY } = {}) {
  if (!(level in LEVELS)) throw new Error(`Unknown log level "${level}"`);
  const threshold = LEVELS[level];
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  }

  function write(lvl, scope, args) {
    if (LEVELS[lvl] < threshold) return;
    const time = new Date().toISOString();
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    const tag = lvl.toUpperCase().padEnd(5);
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${time} ${tag} ${prefix}${text}`;
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(colors ? `${COLORS[lvl]}${line}${RESET}\n` : `${line}\n`);
    if (stream) stream.write(`${line}\n`);
  }

  function make(scope) {
    return {
      debug: (...a) => write('debug', scope, a),
      info: (...a) => write('info', scope, a),
      warn: (...a) => write('warn', scope, a),
      error: (...a) => write('error', scope, a),
      child: (name) => make(scope ? `${scope}:${name}` : name),
      isDebug: () => threshold <= LEVELS.debug,
      close: () => new Promise((resolve) => (stream ? stream.end(resolve) : resolve())),
    };
  }
  return make(null);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
