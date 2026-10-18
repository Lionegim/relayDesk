// OAuth 2.0 Microsoft (plateforme d'identité v2) pour client public de bureau : redirection loopback + PKCE.
// Comptes personnels et professionnels (tenant « common » par défaut). Aucun secret client.
import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from '../../http/errors.js';

const GRAPH = 'https://graph.microsoft.com/';
const STATE_TTL_MS = 10 * 60 * 1000;
const BASE_SCOPES = ['openid', 'email', 'offline_access', `${GRAPH}User.Read`];

// Capacités Relay → permission Graph demandée. Mail.ReadWrite couvre classement et brouillons.
export const OUTLOOK_SCOPES = {
  read: `${GRAPH}Mail.Read`,
  labels: `${GRAPH}Mail.ReadWrite`,
  drafts: `${GRAPH}Mail.ReadWrite`,
  send: `${GRAPH}Mail.Send`,
};

// Les jetons Microsoft peuvent renvoyer les permissions avec ou sans préfixe et dans une autre casse.
export const normalizeScopes = scopes => [...new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/))
  .filter(Boolean).map(s => s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')))];

export function grantedPermissions(scopes) {
  const s = new Set(normalizeScopes(scopes));
  const rw = s.has('mail.readwrite');
  return [
    (rw || s.has('mail.read')) && 'read',
    rw && 'labels',
    rw && 'drafts',
    s.has('mail.send') && 'send',
  ].filter(Boolean);
}

const b64url = buf => buf.toString('base64url');

export function createMicrosoftOAuth({ clientId, tenant = 'common', fetchImpl = globalThis.fetch }) {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0/`;
  const pending = new Map();
  const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); };

  async function token(params) {
    let res;
    try {
      res = await fetchImpl(base + 'token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, ...params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'Microsoft est injoignable.', 'retryable');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Seul le code d'erreur est repris : jamais la description complète (elle peut contenir des identifiants).
      const code = typeof data.error === 'string' ? data.error : String(res.status);
      if (code === 'invalid_grant' || code === 'interaction_required') throw new HttpError(401, 'Accès Microsoft expiré ou révoqué : reconnecte le compte.', 'invalid_grant');
      throw new HttpError(res.status >= 500 ? 503 : 502, `Microsoft a refusé l’autorisation (${code}).`, res.status >= 500 ? 'retryable' : 'microsoft_oauth');
    }
    return data;
  }

  // Repli si l'id_token ne porte pas d'adresse (certains comptes professionnels) : /me avec le jeton d'accès.
  async function meAddress(accessToken) {
    try {
      const res = await fetchImpl('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const me = await res.json();
      const v = me.mail || me.userPrincipalName;
      return typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  return {
    configured: !!clientId,

    start({ redirectUri, context, perms = ['read'] }) {
      if (!clientId) throw new HttpError(503, 'Connexion Outlook non configurée : renseigne MICROSOFT_CLIENT_ID.', 'outlook_unconfigured');
      if (!Array.isArray(perms) || perms.some(p => !Object.hasOwn(OUTLOOK_SCOPES, p))) throw new HttpError(400, 'Permission Outlook invalide.', 'oauth_scope');
      sweep();
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(48));
      const scope = [...new Set([...BASE_SCOPES, ...['read', ...perms].map(p => OUTLOOK_SCOPES[p])])].join(' ');
      pending.set(state, { verifier, redirectUri, scope, context, expires: Date.now() + STATE_TTL_MS });
      const url = new URL(base + 'authorize');
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope, state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
        prompt: 'select_account', ...(context?.address ? { login_hint: context.address } : {}),
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
      const t = await token({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, redirect_uri: entry.redirectUri, scope: entry.scope });
      if (!t.refresh_token) throw new HttpError(502, 'Microsoft n’a pas fourni de jeton de rafraîchissement (offline_access refusé ?).', 'oauth_no_refresh');
      // Permissions réellement accordées, telles que renvoyées par le point de jeton (jamais celles demandées).
      const scopes = normalizeScopes(t.scope);
      if (!grantedPermissions(scopes).includes('read')) throw new HttpError(403, 'La lecture des messages Outlook n’a pas été autorisée.', 'oauth_scope');
      // Adresse de boîte (SMTP) d'abord : le nom de connexion (UPN, preferred_username) peut en différer et ferait
      // échouer l'envoi (SendAsDenied). Repli sur l'id_token seulement si /me est illisible.
      const email = await meAddress(t.access_token) || addressFromIdToken(t.id_token);
      if (!email) throw new HttpError(502, 'Adresse du compte Microsoft introuvable.', 'oauth_no_email');
      return { context: entry.context, email, refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, idToken: t.id_token, scopes };
    },

    // Microsoft renvoie souvent un nouveau jeton de rafraîchissement : l'appelant doit le conserver.
    refresh: refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

// Repli : adresse depuis l'id_token reçu directement du point de jeton en TLS (signature non revérifiée).
// `preferred_username` est un nom de connexion, pas forcément l'adresse de la boîte.
export function addressFromIdToken(idToken) {
  try {
    const c = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const v = c.email || c.preferred_username;
    return typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}
