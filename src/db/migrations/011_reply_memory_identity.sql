-- Identité stable d'une mémoire : les révisions changent, une suppression/recréation ne réutilise jamais son identité.
ALTER TABLE reply_memory ADD COLUMN identity TEXT NOT NULL DEFAULT '';
UPDATE reply_memory SET identity = lower(hex(randomblob(16)));
