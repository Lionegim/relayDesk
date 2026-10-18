-- Auteurs des textes de groupe : la direction reste from_me, jamais déduite du nom.
ALTER TABLE whatsapp_messages ADD COLUMN author_jid TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN sender_name TEXT;
