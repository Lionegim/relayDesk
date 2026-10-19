-- Archive import checkpoints are independent of the live provider cursors.
CREATE TABLE mail_history_imports (
 account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL,
 identity TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','paused','retrying','complete')),
 cursor TEXT,
 enumerated INTEGER NOT NULL DEFAULT 0,
 discovered INTEGER NOT NULL DEFAULT 0,
 done INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 started_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE mail_history_items (
 account_id INTEGER NOT NULL REFERENCES mail_history_imports(account_id) ON DELETE CASCADE,
 external_id TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,external_id)
);
CREATE INDEX mail_history_pending ON mail_history_items(account_id,done);
