-- Les compositions sans fil reçu partagent le cycle de brouillon, mais ne simulent pas une conversation distante.
ALTER TABLE messages ADD COLUMN compose_kind TEXT NOT NULL DEFAULT 'received';
ALTER TABLE messages ADD COLUMN draft_cc TEXT;
