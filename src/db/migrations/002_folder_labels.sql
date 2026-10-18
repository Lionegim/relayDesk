CREATE TABLE folder_labels (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL,
  PRIMARY KEY (folder_id, account_id)
);
CREATE INDEX folder_labels_account_label ON folder_labels (account_id, label_id);

INSERT INTO folder_labels (folder_id, account_id, label_id)
SELECT id, account_id, external_id FROM folders
WHERE account_id IS NOT NULL AND external_id IS NOT NULL;
