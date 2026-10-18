// Toutes les routes de messagerie passent par ce registre, sans connaître le fournisseur.
import { readComposeInput } from '../providers/gmail/outbox.js';
import { HttpError, badRequest } from '../http/errors.js';
export function createMailService({ store, providers }) {
  const providerFor = accountId => {
    const account = store.getAccount(accountId);
    const provider = providers[account.svc];
    if (!provider) throw new HttpError(503, 'Ce fournisseur de messagerie n’est pas configuré.', 'provider_unavailable');
    return provider;
  };
  const forMessage = id => { const {accountId} = store.getMessageSource(id); if (!accountId) throw new HttpError(403, 'Connecte un compte pour envoyer.', 'send_forbidden'); return providerFor(accountId); };
  return {
    providers, providerFor,
    permissions(account) { return providers[account.svc]?.sync.permissions(account.id) || []; },
    createComposition(accountId) {
      if (!Number.isInteger(accountId)) throw badRequest('Compte invalide');
      const p = providerFor(accountId);
      if (!p.sync.permissions(accountId).includes('read')) throw badRequest('Connecte d’abord ce compte de messagerie');
      return store.createComposition(accountId);
    },
    saveDraft(id, input) {
      const {accountId} = store.getMessageSource(id);
      const p = accountId && providers[store.getAccount(accountId).svc];
      if (p) return p.outbox.saveDraft(id, input);
      const parsed = readComposeInput(input);
      return store.saveDraft(id, parsed.text, parsed);
    },
    preview: (id, input) => forMessage(id).outbox.preview(id, input),
    send: (id, input) => forMessage(id).outbox.send(id, input),
    updateMessage(id, input) {
      const source = store.getMessageSource(id);
      if (!source.accountId || store.composeContext(id).kind === 'new') return store.updateMessage(id, input);
      return providers[store.getAccount(source.accountId).svc]?.sync.updateMessage(id, input) || store.updateMessage(id, input);
    },
  };
}
