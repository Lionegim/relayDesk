// Éléments partagés des clients OAuth de messagerie (Google, Microsoft) : modes, empreinte de configuration,
// états de connexion à usage unique et validation des adresses de retour.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../../http/errors.js';

export const MODES = ['desktop', 'web'];
const STATE_TTL_MS = 10 * 60000;
const MAX_PENDING = 100;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const pkceChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');

export class OAuthConfigError extends Error {
  constructor(message) { super(`Configuration OAuth : ${message}`); this.code = 'oauth_configuration'; }
}

export function checkMode(mode) {
  if (!MODES.includes(mode)) throw new OAuthConfigError('mode doit valoir desktop ou web.');
  return mode;
}

// Adresse de retour d'un client Web : HTTPS, absolue, fixe, sans identifiants, requête ni fragment.
export function webRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { throw new OAuthConfigError('redirectUri HTTPS requise en mode web.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new OAuthConfigError('redirectUri doit être une URL HTTPS sans identifiants, requête ni fragment.');
  return u.href;
}

// Client de bureau : retour sur la boucle locale uniquement (RFC 8252).
export function isLoopback(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

/**
 * Empreinte canonique de la configuration du client : fournisseur, mode, identifiant client, adresse de retour fixe (web)
 * et autorité. Jamais le secret. Un jeton de rafraîchissement émis pour une autre empreinte n'est pas réutilisable.
 */
export function oauthBinding({ provider, mode, clientId, redirectUri, authority }) {
  const canonical = JSON.stringify({ v: 1, provider, mode, clientId: clientId || '', redirectUri: mode === 'web' ? redirectUri : 'loopback', authority });
  return createHash('sha256').update(canonical).digest('hex');
}

// États de connexion en attente : bornés, expirés au bout de 10 minutes, consommés une seule fois.
export function createPendingStates({ clock = Date.now, ttlMs = STATE_TTL_MS, max = MAX_PENDING } = {}) {
  const pending = new Map();
  const sweep = () => { const now = clock(); for (const [k, v] of pending) if (v.expires <= now) pending.delete(k); };
  return {
    put(value) {
      sweep();
      while (pending.size >= max) pending.delete(pending.keys().next().value); // les plus anciens cèdent la place
      const state = randomToken();
      pending.set(state, { ...value, expires: clock() + ttlMs });
      return state;
    },
    take(state) {
      if (typeof state !== 'string' || !state) return null;
      const entry = pending.get(state);
      pending.delete(state);
      return entry && entry.expires > clock() ? entry : null;
    },
    get size() { return pending.size; },
  };
}

// Codes d'erreur OAuth reconnus ; tout autre code fournisseur est remplacé par une catégorie générique.
const KNOWN = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope', 'access_denied', 'interaction_required', 'consent_required']);
export const providerErrorCode = data => (typeof data?.error === 'string' && KNOWN.has(data.error) ? data.error : 'other');

export const stateError = () => new HttpError(400, 'Demande d’autorisation expirée ou inconnue. Recommence la connexion.', 'oauth_state');
export const redirectError = () => new HttpError(400, 'Adresse de retour non autorisée pour ce client.', 'oauth_redirect');
