-- Store references only: quoted content is resolved within the retained conversation.
ALTER TABLE whatsapp_messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN draft_reply_to TEXT;
ALTER TABLE messages ADD COLUMN interaction_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE whatsapp_reactions (
 account_id INTEGER NOT NULL,
 chat_jid TEXT NOT NULL,
 msg_id TEXT NOT NULL,
 actor TEXT NOT NULL,
 emoji TEXT NOT NULL,
 ts INTEGER NOT NULL,
 PRIMARY KEY(account_id,chat_jid,msg_id,actor),
 FOREIGN KEY(account_id,chat_jid,msg_id) REFERENCES whatsapp_messages(account_id,chat_jid,msg_id) ON DELETE CASCADE
);
