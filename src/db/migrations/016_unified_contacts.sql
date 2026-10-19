-- Durable merge audit survives reconnects, scans and source record removal.
CREATE TABLE contact_link_history (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('local','unified')),
 scope TEXT NOT NULL, scope_name TEXT NOT NULL,
 target_id TEXT NOT NULL, source_id TEXT NOT NULL,
 target_name TEXT NOT NULL, source_name TEXT NOT NULL,
 members TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT
);
INSERT INTO contact_link_history
SELECT e.id,'local',e.profile_id,p.name,e.target_id,json_extract(e.members,'$.from'),t.name,s.name,e.members,e.created_at,e.undone_at
FROM contact_merge_events e JOIN profiles p ON p.id=e.profile_id JOIN contacts t ON t.id=e.target_id JOIN contacts s ON s.id=json_extract(e.members,'$.from');
CREATE INDEX contact_link_history_time ON contact_link_history(created_at);
-- 'all' is a virtual owner view, never an account destination or an actual profile.
ALTER TABLE contact_duplicate_scans RENAME TO contact_duplicate_scans_old;
CREATE TABLE contact_duplicate_scans (profile_id TEXT PRIMARY KEY,revision TEXT NOT NULL,scanned_at TEXT NOT NULL,crowded INTEGER NOT NULL,limited INTEGER NOT NULL);
INSERT INTO contact_duplicate_scans SELECT * FROM contact_duplicate_scans_old;
DROP TABLE contact_duplicate_scans_old;
ALTER TABLE contact_duplicate_candidates RENAME TO contact_duplicate_candidates_old;
CREATE TABLE contact_duplicate_candidates (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
 left_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 version TEXT NOT NULL,rank INTEGER NOT NULL,reasons TEXT NOT NULL,detected_at TEXT NOT NULL
);
INSERT INTO contact_duplicate_candidates SELECT * FROM contact_duplicate_candidates_old;
DROP TABLE contact_duplicate_candidates_old;
CREATE INDEX contact_duplicates_profile ON contact_duplicate_candidates(profile_id);
CREATE TRIGGER duplicate_profile_insert BEFORE INSERT ON contact_duplicate_candidates
WHEN NEW.profile_id!='all' AND (NEW.profile_id != (SELECT profile_id FROM contacts WHERE id=NEW.left_id) OR NEW.profile_id != (SELECT profile_id FROM contacts WHERE id=NEW.right_id))
BEGIN SELECT RAISE(ABORT,'duplicate profile mismatch'); END;
