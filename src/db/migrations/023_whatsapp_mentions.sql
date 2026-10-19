ALTER TABLE messages ADD COLUMN draft_mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE whatsapp_messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
-- A stable, non-reused identity for each conversation row, independent of draft edits.
ALTER TABLE messages ADD COLUMN conversation_key TEXT NOT NULL DEFAULT '';
UPDATE messages SET conversation_key=lower(hex(randomblob(16)));
CREATE TRIGGER message_conversation_identity AFTER INSERT ON messages WHEN NEW.conversation_key='' BEGIN
 UPDATE messages SET conversation_key=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
