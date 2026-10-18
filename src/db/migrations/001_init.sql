CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  initials TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  svc TEXT,
  status TEXT NOT NULL,
  c TEXT NOT NULL DEFAULT 'muted',
  address TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (profile_id, name)
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, external_id)
);

-- Une ligne par conversation : le dernier message, et les précédents dans `trail` (JSON, du plus récent au plus ancien).
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT,
  from_name TEXT NOT NULL,
  initials TEXT NOT NULL,
  handle TEXT NOT NULL,
  channel TEXT NOT NULL,
  account TEXT NOT NULL,
  time_label TEXT,
  sort_at INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview TEXT NOT NULL,
  body TEXT NOT NULL,
  triage TEXT NOT NULL,
  trail TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 1,
  draft_text TEXT,
  draft_saved_at TEXT,
  UNIQUE (account_id, external_id)
);
CREATE INDEX messages_profile_sort ON messages (profile_id, sort_at DESC);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  freq INTEGER NOT NULL DEFAULT 0,
  channels TEXT NOT NULL DEFAULT '[]',
  last TEXT NOT NULL DEFAULT '',
  groups TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0
);

-- Jetons chiffrés (AES-256-GCM). Jamais renvoyés par l'API.
CREATE TABLE secrets (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  history_id TEXT,
  window_days INTEGER NOT NULL DEFAULT 30,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_sync_at TEXT
);
