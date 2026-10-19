import { HttpError } from '../../http/errors.js';

// Les appels réseau précèdent toute écriture locale, y compris le lien d'un nouveau libellé.
export function createGmailActions({ store, client, permissions }) {
  return {
    async updateMessage(id, patch) {
      const fields = store.validateMessagePatch(id, patch);
      const source = store.getMessageSource(id);
      const accountId = source.accountId;
      if (!accountId || store.getAccount(accountId).svc !== 'gmail' || !permissions(accountId).includes('labels')) {
        return store.updateMessage(id, fields);
      }
      if (!source.externalId) throw new HttpError(502, 'Conversation Gmail introuvable.', 'gmail');
      const gmail = client(accountId);
      const add = new Set(), remove = new Set();
      const toggle = (key, label, invert = false) => {
        if (key in fields) ((fields[key] !== invert) ? add : remove).add(label);
      };
      toggle('unread', 'UNREAD');
      toggle('flagged', 'STARRED');
      toggle('archived', 'INBOX', true);
      let newLink = null;
      try {
        if ('folderId' in fields) {
          const oldLabel = source.folderId && store.folderLabel(source.folderId, accountId);
          let label = fields.folderId && store.folderLabel(fields.folderId, accountId);
          if (fields.folderId && !label) {
            const name = store.folderPath(fields.folderId);
            try {
              label = (await gmail.post('labels', { name })).id;
            } catch (e) {
              if (e.code !== 'conflict') throw e;
              const { labels = [] } = await gmail.labels();
              label = labels.find(l => l.type === 'user' && l.name === name)?.id;
            }
            if (typeof label !== 'string' || !label) throw new HttpError(502, 'Libellé Gmail introuvable.', 'gmail');
            newLink = { folderId: fields.folderId, label };
          }
          if (oldLabel && oldLabel !== label) remove.add(oldLabel);
          if (label && oldLabel !== label) add.add(label);
        }
        if (add.size || remove.size) {
          await gmail.post(`threads/${encodeURIComponent(source.externalId)}/modify`, {
            addLabelIds: [...add], removeLabelIds: [...remove],
          });
        }
      } catch (e) {
        // Ne jamais inclure la réponse Google, le jeton ou le corps du message.
        throw new HttpError(502, `La modification n’a pas été acceptée par Gmail${e.code === 'invalid_grant' ? ' : reconnecte le compte' : ''}.`, 'gmail_write');
      }
      return store.transaction(() => {
        if (newLink) store.linkFolderLabel(newLink.folderId, accountId, newLink.label);
        return store.updateMessage(id, fields);
      });
    },
  };
}
