// OAuth 2.0 Google. Deux modes explicites :
// - desktop (défaut, rétrocompatible) : client « application de bureau », retour sur la boucle locale ;
// - web : client Web confidentiel, adresse de retour HTTPS fixe, identité lue sur le profil Gmail.
// Dans les deux cas : PKCE S256, state et nonce, états à usage unique et bornés dans le temps.
import { HttpError } from '../../http/errors.js';
import {
  checkMode, createPendingStates, isLoopback, oauthBinding, OAuthConfigError, pkceChallenge, providerErrorCode,
  randomToken, redirectError, stateError, webRedirect,
} from '../oauth/common.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const AUTHORITY = 'https://accounts.google.com';
export const READ_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
export const GMAIL_SCOPES = {
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  read: READ_SCOPES[2],
  labels: 'https://www.googleapis.com/auth/gmail.modify',
  drafts: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
};
export const grantedPermissions = scopes => Object.entries(GMAIL_SCOPES)
  .filter(([cap, scope]) => scopes.includes(scope) || (cap === 'read' && scopes.includes(GMAIL_SCOPES.labels)))
  .map(([cap]) => cap);

export function createGoogleOAuth({ clientId, clientSecret, mode = 'desktop', redirectUri = null, fetchImpl = globalThis.fetch, clock = Date.now }) {
  checkMode(mode);
  const web = mode === 'web';
  const configured = !!(clientId && clientSecret);
  let fixedRedirect = null;
  if (web && clientId) {
    if (!clientSecret) throw new OAuthConfigError('le client Web Google exige un secret.');
    fixedRedirect = webRedirect(redirectUri);
  }
  const binding = oauthBinding({ provider: 'google', mode, clientId, redirectUri: fixedRedirect, authority: AUTHORITY });
  const pending = createPendingStates({ clock });

  // Secret transmis dans le corps POST uniquement, jamais dans une URL.
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
      const code = providerErrorCode(data);
      throw new HttpError(res.status === 400 || res.status === 401 ? 401 : 502, 'Google a refusé l’autorisation.', code === 'invalid_grant' ? 'invalid_grant' : 'google_oauth');
    }
    return data;
  }

  // Identité fiable en mode web : adresse de la boîte Gmail lue avec le jeton d'accès, pas un claim décodé.
  async function profileAddress(accessToken) {
    let res;
    try {
      res = await fetchImpl(PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
    } catch {
      throw new HttpError(502, 'Google est injoignable.', 'google_unreachable');
    }
    const data = res.ok ? await res.json().catch(() => null) : null;
    const email = typeof data?.emailAddress === 'string' ? data.emailAddress.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(502, 'Adresse du compte Gmail introuvable.', 'oauth_no_email');
    return email;
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

    // Prépare l'URL d'autorisation et retient le contexte (profil, nom, historique) pour le retour.
    start({ redirectUri: requested = null, context, perms = ['read'] }) {
      if (!configured) throw new HttpError(503, 'Connexion Gmail non configurée.', 'gmail_unconfigured');
      if (!Array.isArray(perms) || perms.some(p => !Object.hasOwn(GMAIL_SCOPES, p))) throw new HttpError(400, 'Permission Gmail invalide.', 'oauth_scope');
      const redirect = resolveRedirect(requested);
      const verifier = randomToken(48), nonce = randomToken();
      const state = pending.put({ verifier, nonce, redirect, context });
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code',
        scope: [...new Set(['openid', 'email', ...['read', ...perms].map(p => GMAIL_SCOPES[p])])].join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, nonce,
        code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
      });
      return url.toString();
    },

    // Usage unique : un `state` inconnu, expiré ou rejoué est refusé.
    async finish({ state, code }) {
      const entry = pending.take(state);
      if (!entry) throw stateError();
      if (typeof code !== 'string' || !code || code.length > 2048) throw new HttpError(400, 'Code d’autorisation manquant.', 'oauth_code');
      const t = await token({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, redirect_uri: entry.redirect });
      if (!t.refresh_token) throw new HttpError(502, 'Google n’a pas fourni de jeton de rafraîchissement.', 'oauth_no_refresh');
      const granted = String(t.scope || '').split(/\s+/).filter(Boolean);
      if (!grantedPermissions(granted).includes('read')) throw new HttpError(403, 'La lecture de Gmail n’a pas été autorisée.', 'oauth_scope');
      const email = web ? await profileAddress(t.access_token) : undefined;
      return {
        context: entry.context, ...(web ? { email } : {}), refreshToken: t.refresh_token, accessToken: t.access_token,
        expiresIn: t.expires_in, idToken: t.id_token, scopes: granted, mode, binding,
      };
    },

    // Google peut renvoyer un nouveau jeton de rafraîchissement : l'appelant le conserve s'il est présent.
    refresh: refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

// Mode desktop seulement (rétrocompatibilité) : l'id_token vient directement du point de jeton Google en TLS ;
// l'adresse est lue sans revérifier la signature. Le mode web n'en dépend pas (profil Gmail).
export function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}
