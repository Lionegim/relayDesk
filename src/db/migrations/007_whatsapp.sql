-- WhatsApp (appareil lié) : état d'authentification chiffré, messages texte importés et contacts par compte.

-- Identifiants de session et clés Signal, chacun chiffré séparément par le coffre (AES-256-GCM, AAD du compte).
-- kind : 'creds' ou le type de clé Signal ; key_id : identifiant de la clé ('' pour creds).
CREATE TABLE whatsapp_auth (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (account_id, kind, key_id)
);

-- Messages texte des conversations directes, dédupliqués par compte / discussion / message.
CREATE TABLE whatsapp_messages (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (account_id, chat_jid, msg_id)
);
CREATE INDEX whatsapp_messages_chat ON whatsapp_messages (account_id, chat_jid, ts);

-- Nom affiché de chaque discussion (carnet du téléphone, nom public ou numéro).
CREATE TABLE whatsapp_chats (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (account_id, chat_jid)
);

-- Contacts issus d'un compte : supprimés avec lui. Les contacts existants gardent account_id NULL.
ALTER TABLE contacts ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE contacts ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX contacts_account_external ON contacts (account_id, external_id);
