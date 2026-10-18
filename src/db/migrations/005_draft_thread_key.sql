-- Empreinte du rattachement au fil (mode, fil, In-Reply-To, References) du brouillon distant tel qu'écrit en dernier
-- chez le fournisseur. Écrite seulement lors d'une écriture distante : un enregistrement local ne la change pas.
ALTER TABLE messages ADD COLUMN draft_thread_key TEXT;
