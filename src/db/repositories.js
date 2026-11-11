/**
 * Data-access layer. Services talk to these repositories, never to SQL directly,
 * so the storage engine can be swapped without touching game logic.
 */
export function createRepositories(db) {
  const json = (s) => (s == null ? null : JSON.parse(s));

  const settings = {
    get: (key) => db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null,
    set: (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)),
  };

  const accounts = {
    create: (a) =>
      db.run(
        'INSERT INTO accounts (id, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        a.id, a.displayName, a.email, a.passwordHash, a.createdAt,
      ),
    byId: (id) => mapAccount(db.get('SELECT * FROM accounts WHERE id = ?', id)),
    byEmail: (email) => mapAccount(db.get('SELECT * FROM accounts WHERE email = ?', email)),
    byDisplayName: (name) => mapAccount(db.get('SELECT * FROM accounts WHERE display_name = ?', name)),
    byIds: (ids) => {
      if (!ids.length) return [];
      return db.db.prepare(`SELECT * FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(mapAccount);
    },
    list: () => db.all('SELECT * FROM accounts ORDER BY created_at').map(mapAccount),
    count: () => db.get('SELECT COUNT(*) AS n FROM accounts').n,
    update: (id, fields) => {
      const cols = { displayName: 'display_name', email: 'email', passwordHash: 'password_hash', lastLogin: 'last_login', banned: 'banned', failedLogins: 'failed_logins', lastBuild: 'last_build' };
      const sets = [];
      const values = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!cols[k]) throw new Error(`Unknown account field ${k}`);
        sets.push(`${cols[k]} = ?`);
        values.push(typeof v === 'boolean' ? Number(v) : v);
      }
      if (sets.length) db.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    delete: (id) => db.run('DELETE FROM accounts WHERE id = ?', id),
  };

  const tokens = {
    insert: (t) =>
      db.run(
        'INSERT INTO auth_tokens (id, kind, account_id, client_id, session_id, auth_method, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        t.id, t.kind, t.accountId ?? null, t.clientId, t.sessionId, t.authMethod, t.deviceId ?? null, t.createdAt, t.expiresAt,
      ),
    byId: (id) => mapToken(db.get('SELECT * FROM auth_tokens WHERE id = ?', id)),
    deleteById: (id) => db.run('DELETE FROM auth_tokens WHERE id = ?', id),
    deleteSession: (sessionId) => db.run('DELETE FROM auth_tokens WHERE session_id = ?', sessionId),
    deleteForAccount: (accountId, exceptSessionId = null) =>
      db.run('DELETE FROM auth_tokens WHERE account_id = ? AND session_id != ?', accountId, exceptSessionId ?? ''),
    deleteForAccountClient: (accountId, clientId, exceptSessionId) =>
      db.run('DELETE FROM auth_tokens WHERE account_id = ? AND client_id = ? AND session_id != ?', accountId, clientId, exceptSessionId ?? ''),
    pruneExpired: (now) => db.run('DELETE FROM auth_tokens WHERE expires_at <= ?', now).changes,
  };

  const exchangeCodes = {
    insert: (c) => db.run('INSERT INTO exchange_codes (code, account_id, client_id, expires_at) VALUES (?, ?, ?, ?)', c.code, c.accountId, c.clientId, c.expiresAt),
    consume: (code) => {
      const row = db.get('SELECT * FROM exchange_codes WHERE code = ?', code);
      if (row) db.run('DELETE FROM exchange_codes WHERE code = ?', code);
      return row ? { code: row.code, accountId: row.account_id, clientId: row.client_id, expiresAt: row.expires_at } : null;
    },
    pruneExpired: (now) => db.run('DELETE FROM exchange_codes WHERE expires_at <= ?', now).changes,
  };

  const deviceAuths = {
    insert: (d) => db.run('INSERT INTO device_auths (device_id, account_id, secret_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?)', d.deviceId, d.accountId, d.secretHash, d.userAgent, d.createdAt),
    byId: (deviceId) => {
      const r = db.get('SELECT * FROM device_auths WHERE device_id = ?', deviceId);
      return r ? { deviceId: r.device_id, accountId: r.account_id, secretHash: r.secret_hash, userAgent: r.user_agent, createdAt: r.created_at } : null;
    },
    forAccount: (accountId) =>
      db.all('SELECT * FROM device_auths WHERE account_id = ?', accountId).map((r) => ({ deviceId: r.device_id, accountId: r.account_id, userAgent: r.user_agent, createdAt: r.created_at })),
    delete: (accountId, deviceId) => db.run('DELETE FROM device_auths WHERE account_id = ? AND device_id = ?', accountId, deviceId).changes,
  };

  const profiles = {
    header: (accountId, profileId) => {
      const r = db.get('SELECT rvn, updated_at FROM profiles WHERE account_id = ? AND profile_id = ?', accountId, profileId);
      return r ? { rvn: r.rvn, updated: r.updated_at } : null;
    },
    get: (accountId, profileId) => {
      const row = db.get('SELECT * FROM profiles WHERE account_id = ? AND profile_id = ?', accountId, profileId);
      if (!row) return null;
      const items = {};
      for (const it of db.all('SELECT item_id, template_id, attributes, quantity FROM profile_items WHERE account_id = ? AND profile_id = ?', accountId, profileId)) {
        items[it.item_id] = { templateId: it.template_id, attributes: json(it.attributes), quantity: it.quantity };
      }
      return { accountId, profileId, rvn: row.rvn, wipeNumber: row.wipe_number, created: row.created_at, updated: row.updated_at, stats: json(row.stats), items };
    },
    insert: (p) => {
      db.run('INSERT INTO profiles (account_id, profile_id, rvn, wipe_number, created_at, updated_at, stats) VALUES (?, ?, ?, ?, ?, ?, ?)',
        p.accountId, p.profileId, p.rvn, p.wipeNumber, p.created, p.updated, JSON.stringify(p.stats));
      for (const [id, item] of Object.entries(p.items)) profiles.upsertItem(p.accountId, p.profileId, id, item);
    },
    updateHeader: (p) =>
      db.run('UPDATE profiles SET rvn = ?, updated_at = ?, stats = ? WHERE account_id = ? AND profile_id = ?', p.rvn, p.updated, JSON.stringify(p.stats), p.accountId, p.profileId),
    upsertItem: (accountId, profileId, itemId, item) =>
      db.run(
        `INSERT INTO profile_items (account_id, profile_id, item_id, template_id, attributes, quantity) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, profile_id, item_id) DO UPDATE SET template_id = excluded.template_id, attributes = excluded.attributes, quantity = excluded.quantity`,
        accountId, profileId, itemId, item.templateId, JSON.stringify(item.attributes ?? {}), item.quantity ?? 1,
      ),
    deleteItem: (accountId, profileId, itemId) => db.run('DELETE FROM profile_items WHERE account_id = ? AND profile_id = ? AND item_id = ?', accountId, profileId, itemId),
    delete: (accountId, profileId) => db.run('DELETE FROM profiles WHERE account_id = ? AND profile_id = ?', accountId, profileId),
    listIds: (accountId) => db.all('SELECT profile_id FROM profiles WHERE account_id = ?', accountId).map((r) => r.profile_id),
  };

  const cloudFiles = {
    list: (accountId) => db.all('SELECT filename, data, updated_at FROM cloud_files WHERE account_id = ?', accountId).map(mapFile),
    get: (accountId, filename) => mapFile(db.get('SELECT filename, data, updated_at FROM cloud_files WHERE account_id = ? AND filename = ?', accountId, filename)),
    put: (accountId, filename, data, updatedAt) =>
      db.run(
        'INSERT INTO cloud_files (account_id, filename, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, filename) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        accountId, filename, data, updatedAt,
      ),
    delete: (accountId, filename) => db.run('DELETE FROM cloud_files WHERE account_id = ? AND filename = ?', accountId, filename).changes,
  };

  const friends = {
    get: (accountId, friendId) => mapFriend(db.get('SELECT * FROM friends WHERE account_id = ? AND friend_id = ?', accountId, friendId)),
    list: (accountId) => db.all('SELECT * FROM friends WHERE account_id = ? ORDER BY created_at', accountId).map(mapFriend),
    upsert: (f) =>
      db.run(
        `INSERT INTO friends (account_id, friend_id, status, direction, created_at, favorite, alias, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, friend_id) DO UPDATE SET status = excluded.status, direction = excluded.direction, favorite = excluded.favorite, alias = excluded.alias, note = excluded.note`,
        f.accountId, f.friendId, f.status, f.direction, f.created, f.favorite ? 1 : 0, f.alias ?? '', f.note ?? '',
      ),
    delete: (accountId, friendId) => db.run('DELETE FROM friends WHERE account_id = ? AND friend_id = ?', accountId, friendId).changes,
  };

  const blocks = {
    list: (accountId) => db.all('SELECT blocked_id, created_at FROM blocks WHERE account_id = ?', accountId).map((r) => ({ accountId: r.blocked_id, created: r.created_at })),
    add: (accountId, blockedId, created) => db.run('INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, ?)', accountId, blockedId, created),
    remove: (accountId, blockedId) => db.run('DELETE FROM blocks WHERE account_id = ? AND blocked_id = ?', accountId, blockedId).changes,
    isBlocked: (accountId, otherId) => !!db.get('SELECT 1 AS x FROM blocks WHERE account_id = ? AND blocked_id = ?', accountId, otherId),
  };

  const stats = {
    all: (accountId) => Object.fromEntries(db.all('SELECT name, value FROM stats WHERE account_id = ?', accountId).map((r) => [r.name, r.value])),
    increment: (accountId, name, by) =>
      db.run('INSERT INTO stats (account_id, name, value) VALUES (?, ?, ?) ON CONFLICT(account_id, name) DO UPDATE SET value = value + excluded.value', accountId, name, by),
    set: (accountId, name, value) =>
      db.run('INSERT INTO stats (account_id, name, value) VALUES (?, ?, ?) ON CONFLICT(account_id, name) DO UPDATE SET value = excluded.value', accountId, name, value),
  };

  const seasons = {
    get: (accountId, season) => json(db.get('SELECT data FROM season_progress WHERE account_id = ? AND season = ?', accountId, season)?.data),
    put: (accountId, season, data) =>
      db.run('INSERT INTO season_progress (account_id, season, data) VALUES (?, ?, ?) ON CONFLICT(account_id, season) DO UPDATE SET data = excluded.data', accountId, season, JSON.stringify(data)),
    list: (accountId) => db.all('SELECT season, data FROM season_progress WHERE account_id = ? ORDER BY season', accountId).map((r) => ({ seasonNumber: r.season, data: json(r.data) })),
  };

  const locker = {
    get: (accountId) => {
      const r = db.get('SELECT data, updated_at FROM locker WHERE account_id = ?', accountId);
      return r ? { data: json(r.data), updated: r.updated_at } : null;
    },
    put: (accountId, data, updated) =>
      db.run('INSERT INTO locker (account_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', accountId, JSON.stringify(data), updated),
    presets: (accountId, kind) =>
      db.all('SELECT loadout_type, preset_index, data FROM locker_presets WHERE account_id = ? AND kind = ? ORDER BY loadout_type, preset_index', accountId, kind).map((r) => json(r.data)),
    putPreset: (accountId, kind, loadoutType, index, data) =>
      db.run(
        'INSERT INTO locker_presets (account_id, kind, loadout_type, preset_index, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, kind, loadout_type, preset_index) DO UPDATE SET data = excluded.data',
        accountId, kind, loadoutType, index, JSON.stringify(data),
      ),
    deletePreset: (accountId, kind, loadoutType, index) =>
      db.run('DELETE FROM locker_presets WHERE account_id = ? AND kind = ? AND loadout_type = ? AND preset_index = ?', accountId, kind, loadoutType, index).changes,
  };

  return { settings, accounts, tokens, exchangeCodes, deviceAuths, profiles, cloudFiles, friends, blocks, stats, seasons, locker };
}

function mapAccount(r) {
  if (!r) return null;
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    lastLogin: r.last_login,
    banned: !!r.banned,
    failedLogins: r.failed_logins,
    lastBuild: r.last_build,
  };
}

function mapToken(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    accountId: r.account_id,
    clientId: r.client_id,
    sessionId: r.session_id,
    authMethod: r.auth_method,
    deviceId: r.device_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function mapFile(r) {
  if (!r) return null;
  return { filename: r.filename, data: Buffer.from(r.data), updated: r.updated_at };
}

function mapFriend(r) {
  if (!r) return null;
  return {
    accountId: r.account_id,
    friendId: r.friend_id,
    status: r.status,
    direction: r.direction,
    created: r.created_at,
    favorite: !!r.favorite,
    alias: r.alias,
    note: r.note,
  };
}
