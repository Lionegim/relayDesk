-- Lot C : en-têtes du dernier message (pour répondre dans le fil) et brouillon Gmail associé.
-- reply_meta : JSON { from, to, cc, replyTo, messageId, references, at }.
ALTER TABLE messages ADD COLUMN reply_meta TEXT;
ALTER TABLE messages ADD COLUMN draft_mode TEXT;
ALTER TABLE messages ADD COLUMN draft_to TEXT;
ALTER TABLE messages ADD COLUMN draft_external_id TEXT;
