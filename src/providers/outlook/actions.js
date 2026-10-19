// Classement Outlook (Mail.ReadWrite) : lu/non lu, drapeau, archivage et dossiers, appliqués aux messages de la
// conversation dans Graph avant toute écriture locale. Équivalent du module Gmail, sur des messages plutôt qu'un fil.
import { HttpError } from '../../http/errors.js';

const at = m => Date.parse(m.receivedDateTime || m.sentDateTime || '') || 0;
// Comme à l'import : les messages de ces dossiers ne font pas partie de la conversation affichée et ne sont jamais modifiés.
const SKIPPED = ['deleteditems', 'junkemail', 'drafts', 'outbox'];

export function createOutlookActions({ store, client, permissions }) {
  // Dossier Outlook correspondant au chemin du dossier Relay ; créé segment par segment s'il manque.
  async function ensureFolderPath(graph, path) {
    let parent = null;
    for (const name of path.split('/').filter(Boolean)) {
      const list = (parent ? await graph.childFolders(parent) : await graph.folders()).value || [];
      let found = list.find(f => f.displayName === name);
      if (!found) {
        try {
          found = await graph.createFolder(name, parent);
        } catch (e) {
          if (e.code !== 'conflict') throw e;
          found = ((parent ? await graph.childFolders(parent) : await graph.folders()).value || []).find(f => f.displayName === name);
        }
      }
      if (!found?.id) throw new HttpError(502, 'Dossier Outlook introuvable.', 'outlook_write');
      parent = found.id;
    }
    return parent;
  }

  return {
    async updateMessage(id, patch) {
      const fields = store.validateMessagePatch(id, patch);
      const source = store.getMessageSource(id);
      const accountId = source.accountId;
      if (!accountId || store.getAccount(accountId).svc !== 'outlook' || !permissions(accountId).includes('labels')) {
        return store.updateMessage(id, fields);
      }
      if (!source.externalId) throw new HttpError(502, 'Conversation Outlook introuvable.', 'outlook_write');
      const graph = client(accountId);
      let newLink = null;
      try {
        const skip = new Set();
        for (const name of SKIPPED) {
          try { skip.add((await graph.wellKnown(name)).id); } catch (e) { if (e.code !== 'not_found') throw e; }
        }
        const load = async () => (await graph.conversation(source.externalId))
          .filter(m => !m.isDraft && !skip.has(m.parentFolderId)).sort((a, b) => at(a) - at(b));
        let msgs = await load();
        if (!msgs.length) throw new HttpError(404, 'Conversation Outlook introuvable.', 'not_found');
        const inbox = (await graph.wellKnown('inbox')).id;
        if ('unread' in fields) {
          // Non lu : le dernier message seulement ; lu : tous ceux qui ne le sont pas.
          const targets = fields.unread ? [msgs.at(-1)] : msgs.filter(m => !m.isRead);
          for (const m of targets) await graph.patchMessage(m.id, { isRead: !fields.unread });
        }
        if ('flagged' in fields) {
          const targets = fields.flagged ? [msgs.at(-1)] : msgs.filter(m => m.flag?.flagStatus === 'flagged');
          for (const m of targets) await graph.patchMessage(m.id, { flag: { flagStatus: fields.flagged ? 'flagged' : 'notFlagged' } });
        }
        if ('archived' in fields) {
          // Visible = au moins un message dans la boîte de réception ou un dossier personnel (même règle qu'à l'import).
          const archive = (await graph.wellKnown('archive')).id;
          const sent = (await graph.wellKnown('sentitems').catch(() => ({}))).id;
          const shown = m => m.parentFolderId !== archive && m.parentFolderId !== sent;
          if (fields.archived) {
            for (const m of msgs.filter(shown)) await graph.move(m.id, archive);
          } else if (!msgs.some(shown)) {
            await graph.move(msgs.at(-1).id, inbox);
          }
          msgs = await load(); // un déplacement change l'identifiant des messages
        }
        if ('folderId' in fields) {
          const oldFolder = source.folderId && store.folderLabel(source.folderId, accountId);
          let target = fields.folderId && store.folderLabel(fields.folderId, accountId);
          if (fields.folderId && !target) {
            target = await ensureFolderPath(graph, store.folderPath(fields.folderId));
            newLink = { folderId: fields.folderId, label: target };
          }
          // Déplacer : les messages de la boîte de réception ou de l'ancien dossier vont dans le nouveau.
          // « Aucun dossier » : les messages de l'ancien dossier reviennent dans la boîte de réception.
          const from = new Set([oldFolder, ...(target ? [inbox] : [])].filter(Boolean));
          const dest = target || inbox;
          for (const m of msgs.filter(m => from.has(m.parentFolderId) && m.parentFolderId !== dest)) await graph.move(m.id, dest);
        }
      } catch (e) {
        // Graph n'offre pas d'écriture atomique sur plusieurs messages : en cas d'erreur, une partie peut déjà être
        // appliquée dans Outlook. Relay ne change rien localement ; la synchronisation suivante reflète l'état réel.
        // Ni réponse Graph, ni jeton, ni contenu dans le message d'erreur.
        throw new HttpError(502, `La modification n’a pas été acceptée par Outlook${e.code === 'invalid_grant' ? ' : reconnecte le compte' : ''}.`, 'outlook_write');
      }
      return store.transaction(() => {
        if (newLink) store.linkFolderLabel(newLink.folderId, accountId, newLink.label);
        return store.updateMessage(id, fields);
      });
    },
  };
}
