// Lot B : déconnexion d'un compte Gmail. Révoque l'accès chez Google (au mieux), puis efface
// le compte et tout ce qui en dépend dans Relay. Les messages restent dans Gmail.
import { badRequest } from '../../http/errors.js';

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export function createGmailDisconnect({ store, vault, sync, fetchImpl = globalThis.fetch, log = console }) {
  async function revoke(token) {
    try {
      const res = await fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10000),
      });
      // 400 invalid_token : déjà révoqué, rien à faire.
      return res.ok || res.status === 400;
    } catch {
      return false;
    }
  }

  return async function disconnect(accountId) {
    const account = store.getAccount(accountId);
    if (account.svc !== 'gmail') throw badRequest('Ce compte n’est pas un compte Gmail.');
    // forget() rejoint la file du compte : la suppression attend la fin de la synchronisation ou de l'action en cours.
    return sync.forget(accountId, async () => {
      if (!store.hasAccount(accountId)) return { disconnected: true, revoked: true };
      const sealed = store.getSecret(accountId);
      let revoked = !sealed;
      if (sealed) {
        try {
          revoked = await revoke(vault.open(accountId, sealed).refreshToken);
        } catch {
          revoked = false;
        }
      }
      if (!revoked) log.warn?.(`Révocation Google impossible pour le compte ${accountId} : accès à retirer depuis myaccount.google.com/permissions.`);
      store.deleteAccount(accountId);
      return { disconnected: true, revoked };
    });
  };
}
