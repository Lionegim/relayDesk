-- Drafts whose origin predates explicit authorship tracking retain preview review.
ALTER TABLE messages ADD COLUMN draft_ai_assisted INTEGER NOT NULL DEFAULT 0 CHECK(draft_ai_assisted IN (0,1));
UPDATE messages SET draft_ai_assisted=1 WHERE draft_saved_at IS NOT NULL;
