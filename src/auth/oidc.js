// Adaptateur OIDC sur openid-client : flux « authorization code » avec PKCE (S256), state et nonce.
// openid-client vérifie l'émetteur, l'audience, la signature (vérification activée ci-dessous), l'expiration,
// le nonce, le state et le PKCE.
import * as client from 'openid-client';

/**
 * fetch : réservé aux tests et à l'intégration sans réseau (émetteur HTTPS simulé). Le serveur ne le fournit jamais ;
 * toutes les requêtes (découverte, JWKS, jeton) passent alors par cette fonction, avec les mêmes vérifications.
 */
export function createOidcClient({ issuer, clientId, clientSecret, redirectUri }, { fetch } = {}) {
  let pending = null;
  // enableNonRepudiationChecks : la signature de l'ID token est vérifiée avec le JWKS de l'émetteur, même reçu
  // directement du point de jeton (sans elle, openid-client s'en remet au TLS, comme le permet la spécification).
  const options = { execute: [client.enableNonRepudiationChecks], ...(fetch ? { [client.customFetch]: (url, init) => fetch(url, init) } : {}) };
  const configuration = () => {
    pending ||= client.discovery(new URL(issuer), clientId, clientSecret, undefined, options)
      .catch(error => { pending = null; throw error; });
    return pending;
  };
  return {
    async authorizationUrl({ state, nonce, codeVerifier, acrValues = null, forceLogin = false }) {
      const config = await configuration();
      const params = {
        redirect_uri: redirectUri, scope: 'openid', response_type: 'code', state, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
      };
      if (acrValues) params.acr_values = acrValues;
      // Réauthentification : nouvelle saisie chez le fournisseur et auth_time récent.
      if (forceLogin) Object.assign(params, { prompt: 'login', max_age: '0' });
      return client.buildAuthorizationUrl(config, params).href;
    },
    // currentUrl : URL complète de retour. Renvoie les claims de l'ID token validé.
    async callback(currentUrl, { codeVerifier, state, nonce, maxAge }) {
      const config = await configuration();
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
        ...(maxAge !== undefined ? { maxAge } : {}),
      });
      return tokens.claims();
    },
    random: {
      state: () => client.randomState(),
      nonce: () => client.randomNonce(),
      codeVerifier: () => client.randomPKCECodeVerifier(),
    },
  };
}
