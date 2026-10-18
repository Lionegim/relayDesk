-- Mémoire propre à un compte et une conversation, indépendante de la fenêtre de messages importés.
CREATE TABLE reply_memory (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  learn_after INTEGER NOT NULL DEFAULT 0,
  revision TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
);
CREATE TABLE reply_memory_samples (
  account_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  sample_key TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation_id, sample_key),
  FOREIGN KEY (account_id, conversation_id) REFERENCES reply_memory(account_id, conversation_id) ON DELETE CASCADE
);
-- Empreintes seules pour éviter d'apprendre à nouveau une proposition IA envoyée sans retouche.
CREATE TABLE reply_memory_suggestions (
  account_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  sample_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, conversation_id, sample_key),
  FOREIGN KEY (account_id, conversation_id) REFERENCES reply_memory(account_id, conversation_id) ON DELETE CASCADE
);
