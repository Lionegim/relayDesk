CREATE TABLE whatsapp_media (
 id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 owner_message INTEGER REFERENCES messages(id) ON DELETE CASCADE,
 chat_jid TEXT, msg_id TEXT, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
 created_at INTEGER NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL,
 UNIQUE(account_id,chat_jid,msg_id),
 FOREIGN KEY(account_id,chat_jid,msg_id) REFERENCES whatsapp_messages(account_id,chat_jid,msg_id) ON DELETE CASCADE
);
