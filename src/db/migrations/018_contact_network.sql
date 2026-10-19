-- Explicit owner groups; membership refers to source records so merges/undo retain it.
CREATE TABLE person_groups(id TEXT PRIMARY KEY,scope TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(scope,name));
CREATE TABLE person_group_members(group_id TEXT NOT NULL REFERENCES person_groups(id) ON DELETE CASCADE,contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,PRIMARY KEY(group_id,contact_id));
CREATE TABLE mail_display(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,revision TEXT NOT NULL,payload TEXT NOT NULL);
