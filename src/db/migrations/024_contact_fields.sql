CREATE TABLE contact_fields (
 id TEXT PRIMARY KEY,
 contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL DEFAULT 'text',
 value TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'manual',
 components TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX contact_fields_owner ON contact_fields(contact_id);
CREATE TABLE contact_file_imports (
 profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL,
 imported INTEGER NOT NULL,
 PRIMARY KEY(profile_id,fingerprint)
);
