import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads optional JSON data files from the data directory, re-reading them when they change
 * on disk so edits apply without a restart.
 */
export function createDataFiles({ config, log }) {
  const cache = new Map();

  function read(relPath) {
    const file = path.join(config.data.dir, relPath);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cache.delete(file);
      return null;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.set(file, { mtimeMs: stat.mtimeMs, value });
      return value;
    } catch (err) {
      log.error(`Ignoring ${relPath}: ${err.message}`);
      cache.set(file, { mtimeMs: stat.mtimeMs, value: null });
      return null;
    }
  }

  /** First existing file among the candidates. */
  function first(...relPaths) {
    for (const p of relPaths) {
      const v = read(p);
      if (v) return v;
    }
    return null;
  }

  return { read, first };
}
