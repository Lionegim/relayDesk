// OAuth de messagerie en mode web (clients confidentiels) et desktop : faux Google et faux Microsoft (fetch injecté).
// Aucun réseau, aucun identifiant réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGoogleOAuth, GMAIL_SCOPES } from '../src/providers/gmail/oauth.js';
import { createMicrosoftOAuth, OUTLOOK_SCOPES } from '../src/providers/outlook/oauth.js';
import { oauthBinding } from '../src/providers/oauth/common.js';

const GOOGLE_CB = 'https://relay.test/oauth/google/callback';
const MS_CB = 'https://relay.test/oauth/microsoft/callback';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const challenge = v => createHash('sha256').update(v).digest('base64url');

function fakeProvider({ profile = { emailAddress: 'jh@gmail.com' }, me = { mail: 'jh@outlook.fr', userPrincipalName: 'login@tenant.fr' }, grantScope } = {}) {
  const f = { tokens: [], gets: [], issued: new Map(), rotations: 0, profile, me, tokenError: null };
  f.authorize = location => {
    const u = new URL(location);
    const code = `code-${f.issued.size + 1}`;
    f.issued.set(code, Object.fromEntries(u.searchParams));
    return { code, state: u.searchParams.get('state'), params: Object.fromEntries(u.searchParams) };
  };
  f.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (init.method === 'POST') {
      // Aucun secret dans l'URL : seulement dans le corps.
      assert.equal(url.search, '');
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      f.tokens.push({ host: url.host, path: url.pathname, body });
      if (f.tokenError) return json(f.tokenError, 400);
      if (body.grant_type === 'authorization_code') {
        const req = f.issued.get(body.code);
        f.issued.delete(body.code);
        if (!req || challenge(body.code_verifier) !== req.code_challenge || body.redirect_uri !== req.redirect_uri) return json({ error: 'invalid_grant' }, 400);
        const scope = grantScope ?? req.scope;
        return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope, id_token: 'x.e30.y' });
      }
      if (body.grant_type === 'refresh_token') {
        if (body.refresh_token === 'revoked') return json({ error: 'invalid_grant', error_description: 'détails internes jh@outlook.fr' }, 400);
        f.rotations++;
        return json({ access_token: `at-r${f.rotations}`, refresh_token: url.host.includes('microsoft') ? `rt-rot-${f.rotations}` : undefined, expires_in: 3600 });
      }
    }
    f.gets.push({ url: url.href, auth: init.headers?.authorization });
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return f.profile ? json(f.profile) : json({ error: {} }, 401);
    if (url.pathname === '/v1.0/me') return f.me ? json(f.me) : json({ error: {} }, 401);
    return json({ error: 'not_found' }, 404);
  };
  return f;
}

const googleWeb = (f, extra = {}) => createGoogleOAuth({ clientId: 'g-web', clientSecret: 'g-secret', mode: 'web', redirectUri: GOOGLE_CB, fetchImpl: f.fetch, ...extra });
const msWeb = (f, extra = {}) => createMicrosoftOAuth({ clientId: 'm-web', clientSecret: 'm-secret', mode: 'web', redirectUri: MS_CB, tenant: 'consumers', fetchImpl: f.fetch, ...extra });

test('configuration : modes explicites, client Web confidentiel et retour HTTPS fixe obligatoires', () => {
  assert.throws(() => createGoogleOAuth({ clientId: 'c', clientSecret: 's', mode: 'hosted' }), e => e.code === 'oauth_configuration');
  assert.throws(() => createGoogleOAuth({ clientId: 'c', clientSecret: '', mode: 'web', redirectUri: GOOGLE_CB }), /secret/);
  assert.throws(() => createGoogleOAuth({ clientId: 'c', clientSecret: 's', mode: 'web' }), /HTTPS/);
  assert.throws(() => createGoogleOAuth({ clientId: 'c', clientSecret: 's', mode: 'web', redirectUri: 'http://relay.test/cb' }), /HTTPS/);
  assert.throws(() => createGoogleOAuth({ clientId: 'c', clientSecret: 's', mode: 'web', redirectUri: `${GOOGLE_CB}?x=1` }), /requête/);
  assert.throws(() => createMicrosoftOAuth({ clientId: 'c', mode: 'web', redirectUri: MS_CB }), /secret/);
  assert.throws(() => createMicrosoftOAuth({ clientId: 'c', clientSecret: 's', mode: 'web', redirectUri: MS_CB, tenant: 'a/b' }), /tenant/);
  // Sans identifiant : non configuré, sans erreur au démarrage.
  assert.equal(createGoogleOAuth({ clientId: '', clientSecret: '', mode: 'web' }).configured, false);
  assert.equal(createMicrosoftOAuth({ clientId: '', mode: 'web' }).configured, false);
  // Desktop par défaut, inchangé.
  const d = createMicrosoftOAuth({ clientId: 'c' });
  assert.equal(d.mode, 'desktop');
  assert.equal(d.configured, true);
});

test('empreinte : canonique, sans secret, sensible au client, au mode, au retour et à l’autorité', () => {
  const f = fakeProvider();
  const a = googleWeb(f), b = googleWeb(f, { clientSecret: 'autre-secret' });
  assert.match(a.binding, /^[0-9a-f]{64}$/);
  assert.equal(a.binding, b.binding, 'le secret n’entre pas dans l’empreinte');
  assert.equal(a.binding, oauthBinding({ provider: 'google', mode: 'web', clientId: 'g-web', redirectUri: GOOGLE_CB, authority: 'https://accounts.google.com' }));
  assert.notEqual(a.binding, googleWeb(f, { clientId: 'g-autre' }).binding);
  assert.notEqual(a.binding, googleWeb(f, { redirectUri: 'https://autre.test/oauth/google/callback' }).binding);
  assert.notEqual(a.binding, createGoogleOAuth({ clientId: 'g-web', clientSecret: 'g-secret' }).binding, 'desktop ≠ web');
  const m = msWeb(f);
  assert.notEqual(m.binding, msWeb(f, { tenant: 'organizations' }).binding);
  assert.equal(m.binding, msWeb(f, { clientSecret: 'x' }).binding);
  for (const o of [a, m]) assert.ok(!JSON.stringify(o).includes('secret'));
});

test('Google web : retour fixe, PKCE, state et nonce, identité par le profil Gmail, secret dans le corps', async () => {
  const f = fakeProvider();
  const oauth = googleWeb(f);
  assert.throws(() => oauth.start({ redirectUri: 'https://evil.test/cb', context: {} }), e => e.code === 'oauth_redirect');
  const location = oauth.start({ redirectUri: GOOGLE_CB, context: { profileId: 'perso' }, perms: ['send'] });
  const { code, state, params } = f.authorize(location);
  assert.equal(new URL(location).origin, 'https://accounts.google.com');
  assert.equal(params.redirect_uri, GOOGLE_CB);
  assert.equal(params.code_challenge_method, 'S256');
  assert.ok(params.nonce && params.state && params.code_challenge);
  assert.ok(!location.includes('g-secret'), 'aucun secret dans l’URL');
  assert.equal(params.access_type, 'offline');
  assert.ok(params.scope.includes(GMAIL_SCOPES.send));
  const r = await oauth.finish({ state, code });
  assert.equal(r.email, 'jh@gmail.com');
  assert.equal(r.binding, oauth.binding);
  assert.equal(r.mode, 'web');
  assert.deepEqual(r.context, { profileId: 'perso' });
  assert.equal(f.tokens[0].body.client_secret, 'g-secret');
  assert.equal(f.gets.at(-1).auth, 'Bearer at-1');
  // Sans retour fourni : celui de la configuration.
  assert.equal(new URL(oauth.start({ context: {} })).searchParams.get('redirect_uri'), GOOGLE_CB);
  // Rafraîchissement : client confidentiel aussi.
  await oauth.refresh('rt-1');
  assert.equal(f.tokens.at(-1).body.client_secret, 'g-secret');
  assert.equal(f.tokens.at(-1).body.grant_type, 'refresh_token');
});

test('Google web : profil illisible ou adresse invalide refusés, jamais l’id_token', async () => {
  for (const profile of [null, { emailAddress: 'pas-une-adresse' }, {}]) {
    const f = fakeProvider({ profile });
    const oauth = googleWeb(f);
    const { code, state } = f.authorize(oauth.start({ context: {} }));
    await assert.rejects(oauth.finish({ state, code }), e => e.code === 'oauth_no_email', JSON.stringify(profile));
  }
});

test('states : inconnus, rejoués, expirés et bornés', async () => {
  let now = 1_000_000;
  const f = fakeProvider();
  const oauth = googleWeb(f, { clock: () => now });
  const a = f.authorize(oauth.start({ context: {} }));
  await assert.rejects(oauth.finish({ state: 'inconnu', code: a.code }), e => e.code === 'oauth_state');
  await oauth.finish(a);
  await assert.rejects(oauth.finish(a), e => e.code === 'oauth_state', 'rejeu');
  const b = f.authorize(oauth.start({ context: {} }));
  now += 10 * 60000 + 1;
  await assert.rejects(oauth.finish(b), e => e.code === 'oauth_state', 'expiré');
  // Un state consommé par une tentative invalide (code manquant) ne peut plus servir.
  const c = f.authorize(oauth.start({ context: {} }));
  await assert.rejects(oauth.finish({ state: c.state, code: '' }), e => e.code === 'oauth_code');
  await assert.rejects(oauth.finish(c), e => e.code === 'oauth_state');
  // Borne : au plus 100 connexions en attente, les plus anciennes cèdent la place.
  const first = f.authorize(oauth.start({ context: {} }));
  for (let i = 0; i < 100; i++) oauth.start({ context: {} });
  await assert.rejects(oauth.finish(first), e => e.code === 'oauth_state');
});

test('erreurs fournisseur : catégories connues seulement, sans description ni code arbitraire', async () => {
  const f = fakeProvider();
  const oauth = googleWeb(f);
  const a = f.authorize(oauth.start({ context: {} }));
  f.tokenError = { error: 'mon_code_interne', error_description: 'détails jh@gmail.com' };
  await assert.rejects(oauth.finish(a), e => e.code === 'google_oauth' && !/mon_code|jh@|détails/.test(e.message));
  const m = msWeb(f);
  const b = f.authorize(m.start({ context: {} }));
  await assert.rejects(m.finish(b), e => e.code === 'microsoft_oauth' && !/mon_code|jh@|détails/.test(e.message));
  f.tokenError = null;
  await assert.rejects(m.refresh('revoked'), e => e.code === 'invalid_grant' && !/jh@/.test(e.message));
});

test('Microsoft web : secret au code et au rafraîchissement, rotation, identité Graph uniquement', async () => {
  const f = fakeProvider({ grantScope: `openid offline_access ${OUTLOOK_SCOPES.read} ${OUTLOOK_SCOPES.send}` });
  const oauth = msWeb(f);
  assert.throws(() => oauth.start({ redirectUri: 'http://localhost:4310/oauth/microsoft/callback', context: {} }), e => e.code === 'oauth_redirect');
  const location = oauth.start({ context: { address: 'jh@outlook.fr' }, perms: ['send'] });
  const u = new URL(location);
  assert.equal(u.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.ok(!location.includes('m-secret'));
  const { code, state, params } = f.authorize(location);
  assert.equal(params.redirect_uri, MS_CB);
  assert.ok(params.nonce);
  assert.equal(params.login_hint, 'jh@outlook.fr');
  const r = await oauth.finish({ state, code });
  assert.equal(r.email, 'jh@outlook.fr', 'adresse SMTP de /me');
  assert.equal(r.binding, oauth.binding);
  assert.equal(f.tokens[0].body.client_secret, 'm-secret');
  // Rotation : chaque rafraîchissement renvoie un nouveau jeton, avec le secret du client Web.
  const t1 = await oauth.refresh('rt-1'), t2 = await oauth.refresh(t1.refresh_token);
  assert.deepEqual([t1.refresh_token, t2.refresh_token], ['rt-rot-1', 'rt-rot-2']);
  for (const t of f.tokens.slice(1)) assert.equal(t.body.client_secret, 'm-secret');
  // Sans mail : UPN de Graph. Graph illisible : refus, jamais l'id_token en mode web.
  f.me = { mail: null, userPrincipalName: 'upn@tenant.fr' };
  const b = f.authorize(oauth.start({ context: {} }));
  assert.equal((await oauth.finish(b)).email, 'upn@tenant.fr');
  f.me = null;
  const c = f.authorize(oauth.start({ context: {} }));
  await assert.rejects(oauth.finish(c), e => e.code === 'oauth_no_email');
});

test('desktop : retour sur la boucle locale seulement, client Microsoft public sans secret', async () => {
  const f = fakeProvider();
  const g = createGoogleOAuth({ clientId: 'g-desk', clientSecret: 'g-desk-secret', fetchImpl: f.fetch });
  assert.throws(() => g.start({ redirectUri: 'https://relay.test/oauth/google/callback', context: {} }), e => e.code === 'oauth_redirect');
  const a = f.authorize(g.start({ redirectUri: 'http://127.0.0.1:4310/oauth/google/callback', context: {} }));
  const r = await g.finish(a);
  assert.equal(r.email, undefined, 'desktop : adresse lue ensuite par l’application, comme avant');
  assert.equal(r.mode, 'desktop');
  const m = createMicrosoftOAuth({ clientId: 'm-desk', clientSecret: 'ignoré', fetchImpl: f.fetch });
  const b = f.authorize(m.start({ redirectUri: 'http://localhost:4310/oauth/microsoft/callback', context: {} }));
  await m.finish(b);
  await m.refresh('rt-1');
  for (const t of f.tokens.filter(x => x.host === 'login.microsoftonline.com')) assert.equal(t.body.client_secret, undefined);
});
