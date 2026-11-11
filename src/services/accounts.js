import crypto from 'node:crypto';
import { Errors } from '../core/errors.js';
import { hexId, isoNow } from '../core/util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const DISPLAY_NAME_RE = /^[A-Za-z0-9 _\-.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(expected, actual);
}

/** Account creation, lookup and the public account views returned by the account service. */
export function createAccountService({ repos, config, log }) {
  const aLog = log.child('accounts');

  function validateDisplayName(name) {
    if (typeof name !== 'string' || !DISPLAY_NAME_RE.test(name)) {
      throw Errors.validation('Display names must be 3-32 characters of letters, numbers, spaces, "-", "_" or "."');
    }
  }

  function create({ email, displayName, password }) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 256) throw Errors.validation('Password must be 1-256 characters');
    if (!displayName) displayName = uniqueNameFrom(email);
    if (!email) email = `${displayName.replace(/\s+/g, '').toLowerCase()}@gallium.local`;
    if (!EMAIL_RE.test(email)) throw Errors.validation('Invalid e-mail address');
    validateDisplayName(displayName);
    if (repos.accounts.byDisplayName(displayName)) throw Errors.displayNameTaken(displayName);
    if (repos.accounts.byEmail(email)) throw Errors.validation(`An account already uses the e-mail ${email}`);
    const account = { id: hexId(), displayName, email, passwordHash: hashPassword(password), createdAt: isoNow() };
    repos.accounts.create(account);
    aLog.info(`Created account ${displayName} (${account.id})`);
    return repos.accounts.byId(account.id);
  }

  /** Derive a free display name from an e-mail or login string ("15Bandit@atlas.dev" -> "15Bandit"). */
  function uniqueNameFrom(login) {
    let base = String(login || 'Player').split('@')[0].replace(/[^A-Za-z0-9 _\-.]/g, '').slice(0, 28);
    if (base.length < 3) base = `Player${base}`;
    let name = base;
    for (let i = 2; repos.accounts.byDisplayName(name); i++) name = `${base}${i}`;
    return name;
  }

  /** Accept an e-mail or a display name as the login identifier. */
  function findByLogin(login) {
    if (typeof login !== 'string' || !login) return null;
    return repos.accounts.byEmail(login) || repos.accounts.byDisplayName(login) || (login.includes('@') ? null : repos.accounts.byEmail(`${login}@gallium.local`));
  }

  function get(id) {
    return repos.accounts.byId(id);
  }

  function require(id) {
    const a = repos.accounts.byId(id);
    if (!a) throw Errors.accountNotFound(id);
    return a;
  }

  function publicAccount(a) {
    return {
      id: a.id,
      displayName: a.displayName,
      name: a.displayName,
      email: a.email,
      failedLoginAttempts: a.failedLogins,
      lastLogin: a.lastLogin || a.createdAt,
      numberOfDisplayNameChanges: 0,
      ageGroup: 'UNKNOWN',
      headless: false,
      country: 'US',
      lastName: 'Gallium',
      preferredLanguage: 'en',
      canUpdateDisplayName: false,
      tfaEnabled: true,
      emailVerified: true,
      minorVerified: false,
      minorExpected: false,
      minorStatus: 'NOT_MINOR',
      cabinedMode: false,
      hasHashedEmail: false,
    };
  }

  function summary(a) {
    return { id: a.id, displayName: a.displayName, externalAuths: {} };
  }

  return {
    create,
    uniqueNameFrom,
    findByLogin,
    get,
    require,
    byDisplayName: (n) => repos.accounts.byDisplayName(n),
    byEmail: (e) => repos.accounts.byEmail(e),
    byIds: (ids) => repos.accounts.byIds(ids),
    list: () => repos.accounts.list(),
    count: () => repos.accounts.count(),
    publicAccount,
    summary,
    recordLogin: (id, build) => repos.accounts.update(id, { lastLogin: isoNow(), failedLogins: 0, ...(build ? { lastBuild: build } : {}) }),
    recordFailedLogin: (a) => repos.accounts.update(a.id, { failedLogins: a.failedLogins + 1 }),
    setPassword: (id, password) => {
      if (typeof password !== 'string' || !password) throw Errors.validation('Password must not be empty');
      repos.accounts.update(id, { passwordHash: hashPassword(password) });
    },
    setBanned: (id, banned) => repos.accounts.update(id, { banned }),
    rename: (id, displayName) => {
      validateDisplayName(displayName);
      const other = repos.accounts.byDisplayName(displayName);
      if (other && other.id !== id) throw Errors.displayNameTaken(displayName);
      repos.accounts.update(id, { displayName });
    },
    delete: (id) => repos.accounts.delete(id),
    verifyPassword,
  };
}
