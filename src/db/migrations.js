/**
 * Ordered schema migrations. Never edit an entry that has shipped; append a new one instead.
 * PRAGMA user_version records how many have been applied.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_login    TEXT,
    banned        INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    last_build    TEXT
  );

  CREATE TABLE auth_tokens (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    client_id   TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    device_id   TEXT,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX auth_tokens_account ON auth_tokens(account_id);
  CREATE INDEX auth_tokens_session ON auth_tokens(session_id);

  CREATE TABLE exchange_codes (
    code       TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE device_auths (
    device_id   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE profiles (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    profile_id  TEXT NOT NULL,
    rvn         INTEGER NOT NULL,
    wipe_number INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    stats       TEXT NOT NULL,
    PRIMARY KEY (account_id, profile_id)
  );

  CREATE TABLE profile_items (
    account_id  TEXT NOT NULL,
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    template_id TEXT NOT NULL,
    attributes  TEXT NOT NULL,
    quantity    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, profile_id, item_id),
    FOREIGN KEY (account_id, profile_id) REFERENCES profiles(account_id, profile_id) ON DELETE CASCADE
  );

  CREATE TABLE cloud_files (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL COLLATE NOCASE,
    data       BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, filename)
  );

  CREATE TABLE friends (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    friend_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status     TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'PENDING')),
    direction  TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    created_at TEXT NOT NULL,
    favorite   INTEGER NOT NULL DEFAULT 0,
    alias      TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, friend_id)
  );

  CREATE TABLE blocks (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, blocked_id)
  );

  CREATE TABLE stats (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      INTEGER NOT NULL,
    PRIMARY KEY (account_id, name)
  );

  CREATE TABLE season_progress (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    season     INTEGER NOT NULL,
    data       TEXT NOT NULL,
    PRIMARY KEY (account_id, season)
  );

  CREATE TABLE locker (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE locker_presets (
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('loadout', 'group')),
    loadout_type TEXT NOT NULL,
    preset_index INTEGER NOT NULL,
    data         TEXT NOT NULL,
    PRIMARY KEY (account_id, kind, loadout_type, preset_index)
  );
  `,
];
