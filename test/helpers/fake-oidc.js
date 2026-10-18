// Émetteur OIDC fictif : aucune connexion ni identité réelle.
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
export const ISSUER = 'https://idp.test/realms/relay';
export const PUBLIC = 'https://relay.test';
export const OWNER = 'owner-sub-1';
export const ACR = 'relay-mfa';
const b64 = buf => Buffer.from(buf).toString('base64url');

// ---------- Émetteur OIDC simulé ----------

export function fakeIdp() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const idp = { calls: [], next: {}, tokenRequests: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const signJwt = (payload, { signer = key.privateKey, kid = 'k1' } = {}) => {
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64(JSON.stringify(payload));
    return `${head}.${body}.${b64(sign('sha256', Buffer.from(`${head}.${body}`), signer))}`;
  };
  // Le « navigateur » s'authentifie : l'émetteur émet un code lié aux paramètres de la demande.
  idp.authorize = (location, overrides = {}) => {
    const u = new URL(location);
    const code = b64(randomBytes(16));
    codes.set(code, { params: Object.fromEntries(u.searchParams), overrides });
    return { code, state: u.searchParams.get('state'), params: Object.fromEntries(u.searchParams) };
  };
  idp.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    idp.calls.push(url.pathname);
    if (url.origin !== 'https://idp.test') throw new Error('hôte inattendu');
    if (url.pathname === '/realms/relay/.well-known/openid-configuration') {
      return json({
        issuer: idp.next.discoveryIssuer || ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/realms/relay/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/realms/relay/token') {
      const body = new URLSearchParams(await new Response(init.body).text());
      idp.tokenRequests.push({ body: Object.fromEntries(body), authorization: init.headers instanceof Headers ? init.headers.get('authorization') : null });
      const entry = codes.get(body.get('code'));
      codes.delete(body.get('code'));
      if (!entry) return json({ error: 'invalid_grant' }, 400);
      const challenge = b64(createHash('sha256').update(body.get('code_verifier') || '').digest());
      if (challenge !== entry.params.code_challenge || body.get('redirect_uri') !== entry.params.redirect_uri) return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const o = entry.overrides;
      const claims = { iss: ISSUER, aud: 'relay-client', sub: OWNER, nonce: entry.params.nonce, iat: now, exp: now + 300, auth_time: now - 5, acr: ACR, ...o.claims };
      for (const k of o.drop || []) delete claims[k];
      const idToken = signJwt(claims, o.badSignature ? { signer: other.privateKey } : {});
      return json({ access_token: 'at-fictif', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    return json({ error: 'not_found' }, 404);
  };
  return idp;
}
