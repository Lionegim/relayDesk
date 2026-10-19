-- Original contact records retain their source; grouping is profile-scoped and reversible.
CREATE TABLE contact_identities (
 contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('email','phone')),
 normalized TEXT NOT NULL,
 display_value TEXT NOT NULL,
 source TEXT NOT NULL,
 PRIMARY KEY(contact_id,kind,normalized,source)
);
CREATE INDEX contact_identity_lookup ON contact_identities(kind,normalized);
CREATE TABLE contact_person_links (
 contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
 person_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
);
CREATE TABLE contact_merge_events (
 id TEXT PRIMARY KEY,
 profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 members TEXT NOT NULL,
 undone_at TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE message_identities (
 message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('email','phone')),
 normalized TEXT NOT NULL,
 PRIMARY KEY(message_id,kind,normalized)
);
CREATE INDEX message_identity_lookup ON message_identities(kind,normalized);

-- Database defence in depth: links cannot cross profile boundaries, including direct writes.
CREATE TRIGGER contact_link_profile_insert BEFORE INSERT ON contact_person_links
WHEN (SELECT profile_id FROM contacts WHERE id=NEW.contact_id) != (SELECT profile_id FROM contacts WHERE id=NEW.person_id)
BEGIN SELECT RAISE(ABORT,'contact profile mismatch'); END;
CREATE TRIGGER contact_link_profile_update BEFORE UPDATE ON contact_person_links
WHEN (SELECT profile_id FROM contacts WHERE id=NEW.contact_id) != (SELECT profile_id FROM contacts WHERE id=NEW.person_id)
BEGIN SELECT RAISE(ABORT,'contact profile mismatch'); END;
CREATE TRIGGER contact_merge_profile_insert BEFORE INSERT ON contact_merge_events
WHEN NEW.profile_id != (SELECT profile_id FROM contacts WHERE id=NEW.target_id)
BEGIN SELECT RAISE(ABORT,'contact profile mismatch'); END;
