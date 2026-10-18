-- Résultats liés au contenu exact d'une conversation ; supprimés avec le message / compte.
CREATE TABLE ai_results (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'classify')),
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (message_id, kind)
);
