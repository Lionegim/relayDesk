// Preuve MFA réelle : parcours navigateur « code + PKCE S256 » contre Keycloak, comme le fait Relay Desk.
// Mot de passe puis TOTP calculé depuis le secret de test, échange du code avec le secret du client, puis vérification
// de l'id_token (signature RS256 sur le JWKS publié, iss, aud, nonce, exp, sub, acr). Contrôles de refus : aucun code
// après le seul mot de passe, grant direct refusé, retour non déclaré refusé, PKCE obligatoire.
// N'affiche aucun jeton, code, mot de passe ni secret : seulement les claims non sensibles et les verdicts.
//
//   node deploy/hosted-test/prove-mfa.mjs --issuer https://auth.relay.noegim.com/realms/relay-test \
//     --redirect-uri https://relay.noegim.com/auth/callback --out /root/relay-identity-test-out
// La session SSO créée par le parcours nominal est ensuite réutilisée (mêmes cookies) : un nouvel OTP doit être exigé.
//
// --out : répertoire produit par configure-keycloak.mjs (relay/auth_client_*, relay/auth.env, owner/*).
// Le retour vers Relay Desk n'est jamais suivi : le code est intercepté puis échangé ici, une seule fois.
//
// Bout en bout avec Relay Desk (son propre module OIDC vérifie le jeton) : --relay-url https://relay.noegim.com
// part de /auth/login, passe par Keycloak (mot de passe + OTP), revient sur /auth/callback de Relay, puis vérifie
// qu'/api/state répond 200 avec la session et 401 sans. --relay-connect http://hôte:port force l'adresse de
// connexion (Relay local sans DNS ni TLS), avec le Host de --relay-url.
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp, readSecretFile, parseArgs } from './lib.mjs';

const b64url = buf => Buffer.from(buf).toString('base64url');
const unescapeHtml = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function formAction(html, id) {
  const tag = html.match(new RegExp(`<form[^>]*id="${id}"[^>]*>`))?.[0];
  const action = tag?.match(/action="([^"]+)"/)?.[1];
  return action ? unescapeHtml(action) : null;
}

class Browser {
  constructor(fetchImpl) { this.fetch = fetchImpl; this.jar = new Map(); }
  async go(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') this.jar.delete(name); else this.jar.set(name, value);
    }
    return res;
  }
}

// Requête vers Relay Desk sans suivre les redirections, avec adresse de connexion facultative.
function relayRequest(url, { connect, cookies = new Map() } = {}) {
  // connect : « http://hôte:port » (Relay local sans TLS) ou « https://hôte:port » ; Host et SNI restent ceux de l'URL.
  const u = new URL(url), c = connect ? new URL(connect) : u;
  const [host, port] = [c.hostname, c.port];
  const lib = c.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveP, reject) => {
    const req = lib({ host, port: port || (c.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, method: 'GET', servername: u.hostname,
      headers: { host: u.host, accept: 'application/json, text/html', ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; });
      res.on('end', () => {
        for (const c of [].concat(res.headers['set-cookie'] || [])) { const [pair] = c.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
        resolveP({ status: res.statusCode, location: res.headers.location || '', body, cookies });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('délai dépassé')));
    req.end();
  });
}

// Connexion Keycloak d'un navigateur : mot de passe, contrôle qu'aucun code n'est délivré, puis OTP. Renvoie l'URL de retour.
async function keycloakLogin(b, authUrl, { username, password, otpSecret, redirectUri, check }) {
  let res = await b.go(authUrl);
  const login = formAction(await res.text(), 'kc-form-login');
  check('formulaire de connexion présenté', res.status === 200 && login);
  res = await b.go(login, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, credentialId: '' }) });
  const afterPassword = res.status === 200 ? await res.text() : '';
  check('aucun code après le seul mot de passe', !(res.headers.get('location') || '').startsWith(redirectUri));
  const otpAction = formAction(afterPassword, 'kc-otp-login-form');
  check('second facteur OTP exigé', !!otpAction);
  if (!otpAction) return null;
  // Toujours une fenêtre TOTP neuve : un code déjà présenté (même par une exécution précédente) est refusé par
  // Keycloak (codes non réutilisables) et compterait comme un échec de connexion.
  const wait = 30000 - (Date.now() % 30000) + 200;
  await new Promise(r => setTimeout(r, wait));
  const t = Date.now();
  res = await b.go(otpAction, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ otp: totp(otpSecret, { time: t }), login: 'Sign In' }) });
  const back = new URL(res.headers.get('location') || 'about:blank');
  check('retour exact vers Relay Desk avec un code après OTP', res.status === 302 && `${back.origin}${back.pathname}` === redirectUri && back.searchParams.get('code'));
  return back;
}

function verifyIdToken(idToken, jwks, { issuer, clientId, nonce, now = Date.now() }) {
  const [h, p, s] = idToken.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error(`algorithme inattendu ${header.alg}`);
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.use !== 'enc');
  if (!jwk) throw new Error('clé de signature absente du JWKS');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('signature invalide');
  if (claims.iss !== issuer) throw new Error('iss différent de l’émetteur');
  if (![].concat(claims.aud).includes(clientId)) throw new Error('aud ne contient pas le client');
  if (claims.nonce !== nonce) throw new Error('nonce différent');
  if (!(claims.exp * 1000 > now)) throw new Error('jeton expiré');
  return { header, claims };
}

export async function proveMfa({ issuer, redirectUri, clientId, clientSecret, username, password, otpSecret, expectSub, acr, relayUrl, relayConnect, fetchImpl = globalThis.fetch, log = console.log, negatives = true }) {
  const results = [];
  const check = (label, cond) => { results.push({ label, ok: !!cond }); log(`${cond ? 'OK    ' : 'ÉCHEC '} ${label}`); };
  const disc = await (await fetchImpl(`${issuer}/.well-known/openid-configuration`)).json();
  check('découverte : émetteur exact', disc.issuer === issuer);
  check('découverte : PKCE S256 annoncé', (disc.code_challenge_methods_supported || []).includes('S256'));
  const jwks = await (await fetchImpl(disc.jwks_uri)).json();

  const startAuth = (extra = {}) => {
    const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16));
    const params = { client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: redirectUri, state, nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...extra };
    for (const [k, v] of Object.entries(params)) if (v === null) delete params[k];
    return { url: `${disc.authorization_endpoint}?${new URLSearchParams(params)}`, verifier, state, nonce };
  };

  // 1. Parcours nominal (Relay Desk envoie acr_values) : mot de passe, puis OTP obligatoire.
  const b = new Browser(fetchImpl);
  const a = startAuth(acr ? { acr_values: acr } : {});
  const back = await keycloakLogin(b, a.url, { username, password, otpSecret, redirectUri, check }) || new URL('about:blank');
  check('state conservé', back.searchParams.get('state') === a.state);
  const tok = await fetchImpl(disc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code') || '', redirect_uri: redirectUri, code_verifier: a.verifier }),
  });
  const tokens = tok.ok ? await tok.json() : {};
  check('code échangé avec le secret du client et le vérificateur PKCE', tok.ok && tokens.id_token);
  let summary = null;
  if (tokens.id_token) {
    try {
      const { header, claims } = verifyIdToken(tokens.id_token, jwks, { issuer, clientId, nonce: a.nonce });
      check('id_token : signature RS256 valide sur le JWKS publié, iss/aud/nonce/exp corrects', true);
      check(`id_token : acr = ${acr}`, claims.acr === acr);
      if (expectSub) check('id_token : sub du propriétaire configuré', claims.sub === expectSub);
      check('id_token : auth_time présent', Number.isInteger(claims.auth_time));
      summary = { alg: header.alg, kid: header.kid, iss: claims.iss, aud: claims.aud, sub: claims.sub, acr: claims.acr, auth_time: claims.auth_time };
    } catch (e) { check(`id_token vérifié (${e.message})`, false); }
  }

  // 1 bis. Session SSO existante (mêmes cookies Keycloak) : une nouvelle autorisation ne délivre jamais de code sans
  // nouvel OTP, avec ou sans acr_values (le cookie peut couvrir le mot de passe, jamais le niveau 2 d'âge maximal 0).
  check('session SSO Keycloak ouverte (cookie KEYCLOAK_IDENTITY présent)', b.jar.has('KEYCLOAK_IDENTITY'));
  for (const [label, extra] of [['avec acr_values', acr ? { acr_values: acr } : {}], ['sans acr_values', {}]]) {
    const again = startAuth(extra);
    const r = await b.go(again.url);
    const html = r.status === 200 ? await r.text() : '';
    const direct = (r.headers.get('location') || '').startsWith(redirectUri);
    // Formulaire OTP directement (mot de passe couvert par la session) : prouve la réutilisation ET l'exigence d'OTP.
    check(`session SSO réutilisée (${label}) : mot de passe sauté, aucun code sans nouvel OTP`, !direct && !!formAction(html, 'kc-otp-login-form') && !formAction(html, 'kc-form-login'));
  }

  if (negatives) {
    // 2. Sans acr_values : le minimum du client impose quand même l'OTP.
    const b2 = new Browser(fetchImpl), a2 = startAuth();
    let r2 = await b2.go(a2.url);
    const l2 = formAction(await r2.text(), 'kc-form-login');
    r2 = await b2.go(l2, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, credentialId: '' }) });
    const body2 = r2.status === 200 ? await r2.text() : '';
    check('sans acr_values : OTP toujours exigé, aucun code', !(r2.headers.get('location') || '').startsWith(redirectUri) && !!formAction(body2, 'kc-otp-login-form'));
    // 3. Grant direct (mot de passe) refusé.
    const direct = await fetchImpl(disc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'password', username, password, scope: 'openid' }),
    });
    check('grant direct (mot de passe) refusé', !direct.ok && [400, 401].includes(direct.status));
    // 4. Retour non déclaré refusé (aucune redirection vers lui).
    const evil = await new Browser(fetchImpl).go(startAuth({ redirect_uri: `${new URL(redirectUri).origin}/autre` }).url);
    check('retour non déclaré refusé', evil.status >= 400 && !(evil.headers.get('location') || '').includes('/autre'));
    // 5. PKCE obligatoire.
    const noPkce = await new Browser(fetchImpl).go(startAuth({ code_challenge: null, code_challenge_method: null }).url);
    const loc = noPkce.headers.get('location') || '';
    check('requête sans PKCE refusée', noPkce.status >= 400 || /[?&]error=invalid_request/.test(loc));
    // 6. Flux implicite refusé.
    const implicit = await new Browser(fetchImpl).go(startAuth({ response_type: 'id_token token' }).url);
    const iloc = implicit.headers.get('location') || '';
    check('flux implicite refusé', implicit.status >= 400 || /error=(unauthorized_client|unsupported_response_type|invalid_request)/.test(iloc));
  }
  // 7. Bout en bout : Relay Desk lance la connexion, vérifie lui-même le jeton et ouvre une session propriétaire.
  if (relayUrl) {
    const cookies = new Map();
    const start = await relayRequest(`${relayUrl}/auth/login`, { connect: relayConnect, cookies });
    check('Relay : /auth/login redirige vers l’émetteur', [302, 303].includes(start.status) && start.location.startsWith(disc.authorization_endpoint));
    const authUrl = new URL(start.location);
    check('Relay : PKCE S256 et acr_values envoyés', authUrl.searchParams.get('code_challenge_method') === 'S256' && authUrl.searchParams.get('acr_values') === acr);
    const rb = new Browser(fetchImpl);
    const cb = await keycloakLogin(rb, start.location, { username, password, otpSecret, redirectUri, check });
    if (cb) {
      const done = await relayRequest(`${relayUrl}${cb.pathname}${cb.search}`, { connect: relayConnect, cookies });
      check('Relay : retour accepté (jeton vérifié par Relay, session créée)', [302, 303].includes(done.status) && !/[?&]error=|\/login/.test(done.location));
      const state = await relayRequest(`${relayUrl}/api/state`, { connect: relayConnect, cookies });
      check('Relay : /api/state accessible avec la session propriétaire', state.status === 200);
      const firstPage = await relayRequest(`${relayUrl}/api/state?paged=1&limit=50`, { connect: relayConnect, cookies });
      let data; try { data = JSON.parse(firstPage.body); } catch { /* échec signalé ci-dessous */ }
      check('Relay : démarrage paginé sans profil imposé', firstPage.status === 200 && !!data?.page && data.profiles?.length > 0);
      check('Relay : première page bornée à 50 conversations', Array.isArray(data?.messages) && data.messages.length <= 50);
      const invalidProfile = await relayRequest(`${relayUrl}/api/state?paged=1&profile=profile-does-not-exist`, { connect: relayConnect, cookies });
      check('Relay : profil explicite inconnu toujours refusé', invalidProfile.status === 400);
      const anon = await relayRequest(`${relayUrl}/api/state`, { connect: relayConnect });
      check('Relay : /api/state refusé sans session', anon.status === 401);
    }
  }
  const failed = results.filter(r => !r.ok).length;
  return { ok: failed === 0, failed, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2), { issuer: 'value', 'redirect-uri': 'value', out: 'value', acr: 'value', 'no-negatives': 'flag', 'relay-url': 'value', 'relay-connect': 'value' });
    for (const k of ['issuer', 'redirect-uri', 'out']) if (!a[k]) throw new Error(`--${k} est requis.`);
    const env = Object.fromEntries(readFileSync(join(a.out, 'relay/auth.env'), 'utf8').trim().split('\n').map(l => l.split('=')));
    if (env.AUTH_ISSUER !== a.issuer) throw new Error('--issuer diffère de AUTH_ISSUER produit par la configuration.');
    const r = await proveMfa({
      issuer: a.issuer, redirectUri: a['redirect-uri'], acr: a.acr || env.AUTH_MFA_ACR, expectSub: env.AUTH_OWNER_SUB,
      clientId: readSecretFile(join(a.out, 'relay/auth_client_id'), 'client'), clientSecret: readSecretFile(join(a.out, 'relay/auth_client_secret'), 'secret du client'),
      username: readSecretFile(join(a.out, 'owner/username'), 'utilisateur'), password: readSecretFile(join(a.out, 'owner/password'), 'mot de passe'),
      otpSecret: readSecretFile(join(a.out, 'owner/otp-secret'), 'secret OTP'), negatives: !a['no-negatives'],
      relayUrl: a['relay-url'], relayConnect: a['relay-connect'],
    });
    if (r.summary) console.log(`Claims vérifiés : ${JSON.stringify(r.summary)}`);
    console.log(r.ok ? 'Preuve MFA réussie.' : `Preuve MFA en échec : ${r.failed} contrôle(s).`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`Preuve impossible : ${e.message}`);
    process.exit(1);
  }
}
