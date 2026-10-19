-- Versions monotones partagées : un identifiant SQLite réutilisé n'hérite jamais d'une ancienne version.
ALTER TABLE messages ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET draft_version=id;
CREATE TABLE draft_revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO draft_revision VALUES (1, (SELECT COALESCE(MAX(id),0) FROM messages));
CREATE TRIGGER message_draft_insert AFTER INSERT ON messages BEGIN
 UPDATE draft_revision SET value=value+1 WHERE id=1;
 UPDATE messages SET draft_version=(SELECT value FROM draft_revision WHERE id=1) WHERE id=NEW.id;
END;
CREATE TRIGGER message_draft_update AFTER UPDATE OF draft_text,draft_saved_at,draft_mode,draft_to,draft_cc ON messages BEGIN
 UPDATE draft_revision SET value=value+1 WHERE id=1;
 UPDATE messages SET draft_version=(SELECT value FROM draft_revision WHERE id=1) WHERE id=NEW.id;
END;
CREATE INDEX messages_mobile_list ON messages(profile_id,archived,sort_at DESC,id DESC);
CREATE INDEX whatsapp_history_page ON whatsapp_messages(account_id,chat_jid,ts DESC);
