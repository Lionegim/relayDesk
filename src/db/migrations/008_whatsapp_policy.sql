-- Le choix « messages éphémères » doit survivre à la reconnexion et au redémarrage.
ALTER TABLE whatsapp_chats ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
