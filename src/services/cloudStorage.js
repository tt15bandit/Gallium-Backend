import fs from 'node:fs';
import path from 'node:path';
import { Errors } from '../core/errors.js';
import { isoNow, sha1Hex, sha256Hex } from '../core/util.js';

const MAX_USER_FILE = 4 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.\-]{1,128}$/;

/**
 * Cloud storage:
 *  - system files (hotfix .ini files) served from data/cloudstorage/, with optional per-season
 *    overrides in data/cloudstorage/season<N>/ (same file name wins).
 *  - per-account user files (ClientSettings.Sav) stored in SQLite.
 */
export function createCloudStorageService({ repos, config }) {
  const root = path.join(config.data.dir, 'cloudstorage');
  const startedAt = new Date().toISOString();

  /**
   * XMPP section for DefaultEngine.ini, pointing the client at Gallium's XMPP listener.
   * Builds before Chapter 5 read their XMPP server from here; without it they try Epic's
   * server and never connect (seen in 1.x logs). Raw TCP is sent straight to the XMPP port
   * so launchers that proxy only HTTP (e.g. on 3551) are bypassed.
   */
  function xmppSection(build, requestHost) {
    const rule = build.adapter.xmppHotfix;
    const transport = typeof rule === 'function' ? rule(build) : rule;
    if (!config.xmpp.enabled || !transport) return null;
    // The address this client reached us on (127.0.0.1 locally, the Radmin/LAN IP for friends).
    const host = config.xmpp.advertiseHost || requestHost || (config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host);
    const port = config.xmpp.port || config.server.port;
    const addr = transport === 'ws' ? `ws://${host}` : host;
    const block = (name) => [`[${name}]`, 'bUseSSL=false', `ServerAddr="${addr}"`, `ServerPort=${port}`].join('\r\n');
    return `${block('OnlineSubsystemMcp.Xmpp')}\r\n\r\n${block('OnlineSubsystemMcp.Xmpp Prod')}\r\n`;
  }

  /** System files for a build: user files, plus Gallium's XMPP settings merged into DefaultEngine.ini. */
  function systemEntries(build, requestHost) {
    const entries = new Map();
    for (const [lower, file] of systemFiles(build)) {
      entries.set(lower, { name: path.basename(file), read: () => fs.readFileSync(file), uploaded: fs.statSync(file).mtime.toISOString() });
    }
    const section = xmppSection(build, requestHost);
    if (section) {
      const existing = entries.get('defaultengine.ini');
      const own = existing ? existing.read() : null;
      // A user-supplied XMPP section wins; otherwise ours is appended (or becomes the file).
      if (!own || !/\[OnlineSubsystemMcp\.Xmpp/i.test(own.toString('utf8'))) {
        const data = own ? Buffer.concat([own, Buffer.from(`\r\n${section}`)]) : Buffer.from(section);
        entries.set('defaultengine.ini', { name: existing?.name || 'DefaultEngine.ini', read: () => data, uploaded: existing?.uploaded || startedAt });
      }
    }
    return entries;
  }

  function systemFiles(build) {
    const files = new Map();
    for (const dir of [root, path.join(root, `season${build.season}`)]) {
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of names) {
        if (!d.isFile() || d.name.startsWith('.') || /\.(md|txt)$/i.test(d.name)) continue;
        files.set(d.name.toLowerCase(), path.join(dir, d.name));
      }
    }
    return files;
  }

  function describe(name, data, uploaded, extra = {}) {
    return {
      uniqueFilename: name,
      filename: name,
      hash: sha1Hex(data),
      hash256: sha256Hex(data),
      length: data.length,
      contentType: 'application/octet-stream',
      uploaded,
      storageType: 'S3',
      storageIds: {},
      ...extra,
    };
  }

  return {
    listSystem(build, requestHost) {
      return [...systemEntries(build, requestHost).values()].map((e) => describe(e.name, e.read(), e.uploaded, { doNotCache: true }));
    },
    readSystem(build, name, requestHost) {
      const entry = systemEntries(build, requestHost).get(String(name).toLowerCase());
      if (!entry) throw Errors.notFound(`cloud storage file ${name}`);
      return entry.read();
    },
    listUser(accountId) {
      return repos.cloudFiles.list(accountId).map((f) => describe(f.filename, f.data, f.updated, { accountId, doNotCache: false }));
    },
    readUser(accountId, name) {
      const f = repos.cloudFiles.get(accountId, name);
      if (!f) throw Errors.notFound(`cloud storage file ${name}`);
      return f.data;
    },
    writeUser(accountId, name, data) {
      if (!SAFE_NAME.test(name)) throw Errors.validation('Invalid file name');
      if (!Buffer.isBuffer(data) || data.length === 0) throw Errors.validation('File body is empty');
      if (data.length > MAX_USER_FILE) throw Errors.payloadTooLarge();
      repos.cloudFiles.put(accountId, name, data, isoNow());
    },
    deleteUser(accountId, name) {
      if (!repos.cloudFiles.delete(accountId, name)) throw Errors.notFound(`cloud storage file ${name}`);
    },
  };
}
