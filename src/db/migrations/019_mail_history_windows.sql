-- Existing accounts retain their already-approved history until explicitly changed.
-- New OAuth connections select a window (one year by default) before import.
CREATE TABLE mail_history_windows (
 account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 days INTEGER NOT NULL CHECK(days IN (0,30,90,180,365,730)),
 revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,content_revision INTEGER NOT NULL DEFAULT 0
);
