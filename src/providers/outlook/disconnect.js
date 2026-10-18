// Déconnexion d'un compte Outlook. La plateforme d'identité Microsoft n'offre pas de révocation d'un seul jeton
// d'application (revokeSignInSessions déconnecterait toutes les sessions de l'utilisateur) : Relay oublie le jeton
// et indique où retirer le consentement.
import { badRequest } from '../../http/errors.js';

export const CONSENT_URLS = {
  personal: 'https://account.live.com/consent/Manage',
  work: 'https://myapps.microsoft.com',
};

export function createOutlookDisconnect({ store, sync }) {
  return async function disconnect(accountId) {
    if (store.getAccount(accountId).svc !== 'outlook') throw badRequest('Ce compte n’est pas un compte Outlook.');
    // forget() rejoint la file du compte : la suppression attend la fin de la synchronisation ou de l'action en cours.
    return sync.forget(accountId, async () => {
      if (store.hasAccount(accountId)) store.deleteAccount(accountId);
      return { disconnected: true, revoked: false, consentUrls: CONSENT_URLS };
    });
  };
}
