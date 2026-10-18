// OAuth 2.0 Google pour application de bureau : redirection loopback + PKCE (RFC 7636).
import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from '../../http/errors.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const READ_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
export const GMAIL_SCOPES = {
  read: READ_SCOPES[2],
  labels: 'https://www.googleapis.com/auth/gmail.modify',
  drafts: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
};
export const grantedPermissions = scopes => Object.entries(GMAIL_SCOPES)
  .filter(([cap, scope]) => scopes.includes(scope) || (cap === 'read' && scopes.includes(GMAIL_SCOPES.labels)))
  .map(([cap]) => cap);
const STATE_TTL_MS = 10 * 60 * 1000;

const b64url = buf => buf.toString('base64url');

export function createGoogleOAuth({ clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const pending = new Map();

  const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); };

  async function token(params) {
    let res;
    try {
      res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'Google est injoignable.', 'google_unreachable');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new HttpError(res.status === 400 || res.status === 401 ? 401 : 502, `Google a refusé l’autorisation (${data.error || res.status}).`, data.error === 'invalid_grant' ? 'invalid_grant' : 'google_oauth');
      throw err;
    }
    return data;
  }

  return {
    configured: !!(clientId && clientSecret),

    // Prépare l'URL d'autorisation et retient le contexte (profil, nom, historique) pour le retour.
    start({ redirectUri, context, perms = ['read'] }) {
      if (!Array.isArray(perms) || perms.some(p => !Object.hasOwn(GMAIL_SCOPES, p))) throw new HttpError(400, 'Permission Gmail invalide.', 'oauth_scope');
      sweep();
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(48));
      pending.set(state, { verifier, redirectUri, context, expires: Date.now() + STATE_TTL_MS });
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: [...new Set(['openid', 'email', ...['read', ...perms].map(p => GMAIL_SCOPES[p])])].join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      });
      return url.toString();
    },

    // Usage unique : un `state` inconnu, expiré ou rejoué est refusé.
    async finish({ state, code }) {
      sweep();
      const entry = typeof state === 'string' && pending.get(state);
      if (!entry) throw new HttpError(400, 'Demande d’autorisation expirée ou inconnue. Recommence la connexion.', 'oauth_state');
      pending.delete(state);
      if (typeof code !== 'string' || !code) throw new HttpError(400, 'Code d’autorisation manquant.', 'oauth_code');
      const t = await token({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, redirect_uri: entry.redirectUri });
      if (!t.refresh_token) throw new HttpError(502, 'Google n’a pas fourni de jeton de rafraîchissement.', 'oauth_no_refresh');
      const granted = String(t.scope || '').split(/\s+/).filter(Boolean);
      if (!grantedPermissions(granted).includes('read')) throw new HttpError(403, 'La lecture de Gmail n’a pas été autorisée.', 'oauth_scope');
      return { context: entry.context, refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, idToken: t.id_token, scopes: granted };
    },

    refresh: refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

// L'id_token vient directement du point de jeton Google en TLS : on lit l'adresse sans revérifier la signature.
export function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}
