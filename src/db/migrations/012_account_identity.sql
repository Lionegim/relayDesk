-- Identité interne stable : un id SQLite recyclé ne peut pas reprendre un retour OAuth ancien.
ALTER TABLE accounts ADD COLUMN identity TEXT NOT NULL DEFAULT '';
UPDATE accounts SET identity = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX accounts_identity_unique ON accounts(identity);
CREATE TRIGGER accounts_identity_insert AFTER INSERT ON accounts WHEN NEW.identity = ''
BEGIN
  UPDATE accounts SET identity = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
