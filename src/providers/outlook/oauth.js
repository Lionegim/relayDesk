// OAuth 2.0 Microsoft (plateforme d'identité v2). Deux modes explicites :
// - desktop (défaut, rétrocompatible) : client public de bureau, retour sur la boucle locale, aucun secret ;
// - web : client Web confidentiel, adresse de retour HTTPS fixe, secret dans le corps des requêtes de jeton
//   (code et rafraîchissement), identité lue sur Graph /me.
// Dans les deux cas : PKCE S256, state et nonce, états à usage unique et bornés dans le temps.
import { HttpError } from '../../http/errors.js';
import {
  checkMode, createPendingStates, isLoopback, oauthBinding, OAuthConfigError, pkceChallenge, providerErrorCode,
  randomToken, redirectError, stateError, webRedirect,
} from '../oauth/common.js';

const GRAPH = 'https://graph.microsoft.com/';
const BASE_SCOPES = ['openid', 'email', 'offline_access', `${GRAPH}User.Read`];

// Capacités Relay → permission Graph demandée. Mail.ReadWrite couvre classement et brouillons.
export const OUTLOOK_SCOPES = {
  contacts: `${GRAPH}Contacts.Read`,
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
    s.has('contacts.read') && 'contacts',
  ].filter(Boolean);
}

// Tenant : alias Microsoft, identifiant (GUID) ou nom de domaine vérifié.
const TENANT = /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

export function createMicrosoftOAuth({ clientId, clientSecret = null, mode = 'desktop', redirectUri = null, tenant = 'common', fetchImpl = globalThis.fetch, clock = Date.now }) {
  checkMode(mode);
  const web = mode === 'web';
  const tenantId = tenant || 'common';
  if (!TENANT.test(tenantId)) throw new OAuthConfigError('tenant Microsoft invalide.');
  const authority = `https://login.microsoftonline.com/${tenantId.toLowerCase()}/v2.0`;
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/`;
  let fixedRedirect = null;
  if (web && clientId) {
    if (!clientSecret) throw new OAuthConfigError('le client Web Microsoft exige un secret.');
    fixedRedirect = webRedirect(redirectUri);
  }
  const configured = web ? !!(clientId && clientSecret) : !!clientId;
  const binding = oauthBinding({ provider: 'microsoft', mode, clientId, redirectUri: fixedRedirect, authority });
  const pending = createPendingStates({ clock });

  async function token(params) {
    let res;
    try {
      res = await fetchImpl(base + 'token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // Client Web : secret dans le corps, pour le code comme pour le rafraîchissement. Client public : jamais de secret.
        body: new URLSearchParams({ client_id: clientId, ...(web ? { client_secret: clientSecret } : {}), ...params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'Microsoft est injoignable.', 'retryable');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Seule une catégorie connue est reprise : jamais la description ni un code arbitraire du fournisseur.
      const code = providerErrorCode(data);
      if (code === 'invalid_grant' || code === 'interaction_required') throw new HttpError(401, 'Accès Microsoft expiré ou révoqué : reconnecte le compte.', 'invalid_grant');
      throw new HttpError(res.status >= 500 ? 503 : 502, 'Microsoft a refusé l’autorisation.', res.status >= 500 ? 'retryable' : 'microsoft_oauth');
    }
    return data;
  }

  // Adresse de la boîte d'après Graph /me : adresse SMTP (mail) d'abord, puis nom de connexion (UPN).
  async function meAddress(accessToken) {
    try {
      const res = await fetchImpl('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const me = await res.json();
      const v = me.mail || me.userPrincipalName;
      return typeof v === 'string' && ADDRESS.test(v) ? v.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function resolveRedirect(requested) {
    if (web) {
      if (requested != null && requested !== fixedRedirect) throw redirectError();
      return fixedRedirect;
    }
    if (!isLoopback(requested)) throw redirectError();
    return requested;
  }

  return {
    configured,
    mode,
    binding,

    start({ redirectUri: requested = null, context, perms = ['read'] }) {
      if (!configured) throw new HttpError(503, 'Connexion Outlook non configurée : renseigne l’identifiant du client Microsoft.', 'outlook_unconfigured');
      if (!Array.isArray(perms) || perms.some(p => !Object.hasOwn(OUTLOOK_SCOPES, p))) throw new HttpError(400, 'Permission Outlook invalide.', 'oauth_scope');
      const redirect = resolveRedirect(requested);
      const verifier = randomToken(48), nonce = randomToken();
      const scope = [...new Set([...BASE_SCOPES, ...['read', ...perms].map(p => OUTLOOK_SCOPES[p])])].join(' ');
      const state = pending.put({ verifier, nonce, redirect, scope, context });
      const url = new URL(base + 'authorize');
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope, state, nonce,
        code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
        prompt: 'select_account', ...(typeof context?.address === 'string' && ADDRESS.test(context.address) ? { login_hint: context.address } : {}),
      });
      return url.toString();
    },

    // Usage unique : un `state` inconnu, expiré ou rejoué est refusé.
    async finish({ state, code }) {
      const entry = pending.take(state);
      if (!entry) throw stateError();
      if (typeof code !== 'string' || !code || code.length > 4096) throw new HttpError(400, 'Code d’autorisation manquant.', 'oauth_code');
      const t = await token({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, redirect_uri: entry.redirect, scope: entry.scope });
      if (!t.refresh_token) throw new HttpError(502, 'Microsoft n’a pas fourni de jeton de rafraîchissement (offline_access refusé ?).', 'oauth_no_refresh');
      // Permissions réellement accordées, telles que renvoyées par le point de jeton (jamais celles demandées).
      const scopes = normalizeScopes(t.scope);
      if (!grantedPermissions(scopes).includes('read')) throw new HttpError(403, 'La lecture des messages Outlook n’a pas été autorisée.', 'oauth_scope');
      // Web : seule l'adresse renvoyée par Graph fait foi. Desktop : repli historique sur l'id_token si /me est illisible.
      const email = await meAddress(t.access_token) || (web ? null : addressFromIdToken(t.id_token));
      if (!email) throw new HttpError(502, 'Adresse du compte Microsoft introuvable.', 'oauth_no_email');
      return { context: entry.context, email, refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, idToken: t.id_token, scopes, mode, binding };
    },

    // Microsoft renvoie souvent un nouveau jeton de rafraîchissement : l'appelant doit le conserver.
    refresh: refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

// Mode desktop seulement : adresse depuis l'id_token reçu directement du point de jeton en TLS (signature non
// revérifiée). `preferred_username` est un nom de connexion, pas forcément l'adresse de la boîte.
export function addressFromIdToken(idToken) {
  try {
    const c = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const v = c.email || c.preferred_username;
    return typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}
