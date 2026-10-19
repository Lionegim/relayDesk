CREATE TABLE contact_duplicate_scans (
 profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
 revision TEXT NOT NULL, scanned_at TEXT NOT NULL, crowded INTEGER NOT NULL, limited INTEGER NOT NULL
);
CREATE TABLE contact_duplicate_candidates (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 left_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 version TEXT NOT NULL, rank INTEGER NOT NULL, reasons TEXT NOT NULL, detected_at TEXT NOT NULL
);
CREATE INDEX contact_duplicates_profile ON contact_duplicate_candidates(profile_id);
CREATE TABLE contact_duplicate_reviews (
 candidate_id TEXT NOT NULL, version TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision='dismissed'),
 PRIMARY KEY(candidate_id,version)
);
CREATE TRIGGER duplicate_profile_insert BEFORE INSERT ON contact_duplicate_candidates
WHEN NEW.profile_id != (SELECT profile_id FROM contacts WHERE id=NEW.left_id)
 OR NEW.profile_id != (SELECT profile_id FROM contacts WHERE id=NEW.right_id)
BEGIN SELECT RAISE(ABORT,'duplicate profile mismatch'); END;
