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
    listSystem(build) {
      return [...systemFiles(build).values()].map((file) => {
        const data = fs.readFileSync(file);
        return describe(path.basename(file), data, fs.statSync(file).mtime.toISOString(), { doNotCache: true });
      });
    },
    readSystem(build, name) {
      const file = systemFiles(build).get(String(name).toLowerCase());
      if (!file) throw Errors.notFound(`cloud storage file ${name}`);
      return fs.readFileSync(file);
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
