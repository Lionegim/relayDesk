// Authentification du propriétaire : adaptateur openid-client réel face à un émetteur OIDC simulé (fetch injecté,
// ID tokens RS256 signés, JWKS fictifs). Aucun réseau, aucune identité réelle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createOwnerAuth, readAuthConfig } from '../src/auth/index.js';

import {fakeIdp,ISSUER,PUBLIC,OWNER,ACR} from './helpers/fake-oidc.js';
const b64=buf=>Buffer.from(buf).toString('base64url');

// ---------- Serveur de test : routes /auth/* et une route protégée ----------

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function setup({ env = {}, db = new DatabaseSync(':memory:'), clock = () => Date.now(), idp = fakeIdp(), log } = {}) {
  const auth = readAuthConfig({
    env: { AUTH_ISSUER: ISSUER, AUTH_CLIENT_ID: 'relay-client', AUTH_CLIENT_SECRET: 'secret-fictif', AUTH_OWNER_SUB: OWNER, AUTH_MFA_ACR: ACR, ...env },
    mode: 'hosted', publicBaseUrl: PUBLIC,
  });
  const logs = [];
  const sink = log || { warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const owner = await createOwnerAuth({ config: { mode: 'hosted', auth }, db, clock, oidc: { fetch: idp.fetch }, log: sink });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, PUBLIC);
    if (await owner.handle(req, res, url)) return;
    try {
      const s = owner.requireSession(req);
      owner.assertMutation(req, s);
      if (url.pathname === '/api/sensitive') owner.assertRecent(s);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, session: s.id }));
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ code: e.code }));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = () => {
    const jar = new Map();
    const call = async (method, path, { headers = {}, body } = {}) => {
      const res = await fetch(base + path, { method, redirect: 'manual', body, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers } });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
      }
      return res;
    };
    return { jar, call };
  };
  // Parcours complet : /auth/login → émetteur → /auth/callback.
  const login = async (b, { overrides, tamper, reauth = false } = {}) => {
    const start = await b.call('GET', `/auth/login${reauth ? '?reauth=1' : ''}`);
    assert.equal(start.status, 303);
    const grant = idp.authorize(start.headers.get('location'), overrides);
    const state = tamper?.state ?? grant.state;
    return { start, grant, res: await b.call('GET', `/auth/callback?code=${grant.code}&state=${state}`) };
  };
  const mutate = (b, path, { csrf, origin = PUBLIC, site = 'same-origin', method = 'POST' } = {}) =>
    b.call(method, path, { headers: { origin, 'sec-fetch-site': site, ...(csrf ? { 'x-csrf-token': csrf } : {}) } });
  return { owner, idp, db, logs, browser, login, mutate, close: () => owner.close() };
}
const sessionOf = async b => (await b.call('GET', '/auth/session')).json();

test('live stream checks do not keep an idle owner session alive', async () => {
  let now=Date.now();const t=await setup({clock:()=>now,env:{AUTH_IDLE_TTL_HOURS:'1'}});
  const b=t.browser();assert.equal((await t.login(b)).res.status,303);
  const req={headers:{cookie:[...b.jar].map(([k,v])=>`${k}=${v}`).join('; ')}};
  now+=40*60000;t.owner.requireSession(req,{touch:false});
  now+=21*60000;assert.throws(()=>t.owner.requireSession(req,{touch:false}),e=>e.status===401);
  t.close();
});

test('connexion complète : PKCE S256, state, nonce, acr demandé et vérifié, cookies sûrs', async () => {
  const t = await setup();
  const b = t.browser();
  const anon = await b.call('GET', '/auth/session');
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { enabled: true, authenticated: false });
  assert.equal((await b.call('GET', '/api/data')).status, 401);

  const { start, grant, res } = await t.login(b);
  const p = grant.params;
  assert.equal(p.response_type, 'code');
  assert.equal(p.scope, 'openid');
  assert.equal(p.code_challenge_method, 'S256');
  assert.equal(p.redirect_uri, `${PUBLIC}/auth/callback`);
  assert.equal(p.acr_values, ACR);
  assert.ok(p.state && p.nonce && p.code_challenge);
  const txCookie = start.headers.getSetCookie()[0];
  assert.match(txCookie, /^__Host-relay_login=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const set = res.headers.getSetCookie();
  assert.ok(set.some(c => /^__Host-relay_login=; .*Max-Age=0/.test(c)), 'transaction effacée');
  assert.ok(set.some(c => /^__Host-relay_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=43200$/.test(c)));
  // Client confidentiel : authentification du client au point de jeton, vérificateur PKCE transmis.
  const tr = t.idp.tokenRequests.at(-1);
  assert.ok(tr.authorization?.startsWith('Basic ') || tr.body.client_secret);
  assert.ok(tr.body.code_verifier);

  const s = await sessionOf(b);
  assert.equal(s.enabled, true);
  assert.equal(s.authenticated, true);
  assert.match(s.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(s.sessionId, /^[0-9a-f]{32}$/);
  assert.equal(s.mfa, true);
  assert.equal(s.recent, true);
  assert.equal((await b.call('GET', '/api/data')).status, 200);

  // Seule l'empreinte du jeton est en base.
  const token = b.jar.get('__Host-relay_session');
  const rows = t.db.prepare('SELECT * FROM auth_sessions').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows, (k, v) => (v instanceof Uint8Array ? b64(v) : v)).includes(token));
  // Callback rejoué : transaction à usage unique.
  const replay = await b.call('GET', `/auth/callback?code=${grant.code}&state=${grant.state}`);
  assert.equal(replay.status, 400);
  t.close();
});

test('ID token refusé : émetteur, audience, signature, nonce, expiration, propriétaire, acr, state', async () => {
  const t = await setup();
  const cases = [
    ['émetteur', { claims: { iss: 'https://idp.test/realms/autre' } }, 'login_failed'],
    ['audience', { claims: { aud: 'autre-client' } }, 'login_failed'],
    ['signature', { badSignature: true }, 'login_failed'],
    ['nonce', { claims: { nonce: 'autre' } }, 'login_failed'],
    ['expiration', { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 4000 } }, 'login_failed'],
    ['propriétaire', { claims: { sub: 'quelqu-un-d-autre' } }, 'owner_mismatch'],
    ['acr différent', { claims: { acr: 'password' } }, 'mfa_required'],
    ['acr absent', { drop: ['acr'] }, 'mfa_required'],
  ];
  for (const [label, overrides, code] of cases) {
    const t = await setup(); // instance propre : la limite de débit (10 par minute) n'interfère pas
    const b = t.browser();
    const { res } = await t.login(b, { overrides });
    assert.equal(res.status >= 400, true, `${label} : statut ${res.status}`);
    assert.equal((await res.json()).code, code, label);
    assert.ok(!b.jar.has('__Host-relay_session'), `${label} : aucune session`);
    assert.equal((await b.call('GET', '/auth/session')).status, 401, label);
    assert.ok(!t.logs.join('\n').match(/code=|eyJ|secret-fictif/), `${label} : journaux sans secret`);
    t.close();
  }
  const b = t.browser();
  const { res } = await t.login(b, { tamper: { state: 'falsifie' } });
  assert.equal((await res.json()).code, 'login_failed', 'state');
  // Sans cookie de transaction (navigateur différent) : refus.
  const start = await t.browser().call('GET', '/auth/login');
  const grant = t.idp.authorize(start.headers.get('location'));
  assert.equal((await t.browser().call('GET', `/auth/callback?code=${grant.code}&state=${grant.state}`)).status, 400);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
  // Journaux : codes et jetons jamais écrits.
  assert.ok(!t.logs.join('\n').match(/code=|eyJ|secret-fictif/));
  t.close();
});

test('émetteur de découverte différent de AUTH_ISSUER : connexion impossible', async () => {
  const idp = fakeIdp();
  idp.next.discoveryIssuer = 'https://idp.test/realms/autre';
  const t = await setup({ idp });
  const res = await t.browser().call('GET', '/auth/login');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'idp_unavailable');
  t.close();
});

test('mutations : Origin exact, Fetch Metadata et jeton CSRF de la session', async () => {
  const t = await setup();
  const b = t.browser();
  await t.login(b);
  const { csrfToken } = await sessionOf(b);
  assert.equal((await t.mutate(b, '/api/data')).status, 403, 'sans jeton');
  assert.equal((await t.mutate(b, '/api/data', { csrf: 'x'.repeat(43) })).status, 403, 'jeton faux');
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken, origin: 'https://evil.test' })).status, 403, 'Origin');
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken, origin: 'http://relay.test' })).status, 403, 'schéma');
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken, site: 'cross-site' })).status, 403, 'inter-sites');
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken, site: 'same-site' })).status, 403, 'même site, autre origine');
  assert.equal((await b.call('POST', '/api/data', { headers: { 'x-csrf-token': csrfToken } })).status, 403, 'sans Origin');
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken })).status, 200);
  assert.equal((await t.mutate(b, '/api/data', { csrf: csrfToken, method: 'DELETE' })).status, 200);
  // Le jeton CSRF d'une autre session ne vaut rien ici.
  const other = t.browser();
  await t.login(other);
  const foreign = (await sessionOf(other)).csrfToken;
  assert.equal((await t.mutate(b, '/api/data', { csrf: foreign })).status, 403);
  // Déconnexion : elle-même protégée contre le CSRF, puis jeton invalide.
  assert.equal((await t.mutate(b, '/auth/logout')).status, 403);
  const token = b.jar.get('__Host-relay_session');
  assert.equal((await t.mutate(b, '/auth/logout', { csrf: csrfToken })).status, 200);
  assert.ok(!b.jar.has('__Host-relay_session'));
  b.jar.set('__Host-relay_session', token);
  assert.equal((await b.call('GET', '/api/data')).status, 401, 'cookie ancien rejeté');
  t.close();
});

test('appareils : liste sans secret, révocation récente exigée pour un autre appareil, reconnexion qui tourne le jeton', async () => {
  let now = Date.now();
  const t = await setup({ clock: () => now });
  const phone = t.browser(), mac = t.browser();
  await t.login(phone);
  await t.login(mac);
  const list = await (await mac.call('GET', '/auth/sessions')).json();
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(Object.keys(list.sessions[0]).sort(), ['authenticatedAt', 'createdAt', 'current', 'device', 'expiresAt', 'id', 'lastSeenAt', 'mfa', 'recent']);
  assert.equal(list.sessions.filter(x => x.current).length, 1);
  const phoneId = (await sessionOf(phone)).sessionId;
  const csrf = (await sessionOf(mac)).csrfToken;

  now += 20 * 60000; // au-delà des 10 minutes de confirmation récente
  let res = await t.mutate(mac, `/auth/sessions/${phoneId}`, { csrf, method: 'DELETE' });
  assert.equal((await res.json()).code, 'reauth_required');
  assert.equal((await t.mutate(mac, '/api/sensitive', { csrf })).status, 403);
  // Réauthentification : prompt=login et max_age=0 demandés, auth_time signé exigé ; le jeton du navigateur change.
  const before = mac.jar.get('__Host-relay_session');
  const { grant } = await t.login(mac, { reauth: true, overrides: { claims: { auth_time: Math.floor(now / 1000) } } });
  assert.equal(grant.params.prompt, 'login');
  assert.equal(grant.params.max_age, '0');
  assert.notEqual(mac.jar.get('__Host-relay_session'), before);
  const fresh = await sessionOf(mac);
  res = await t.mutate(mac, `/auth/sessions/${phoneId}`, { csrf: fresh.csrfToken, method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await phone.call('GET', '/api/data')).status, 401, 'appareil révoqué');
  // L'ancien jeton du Mac (avant réauthentification) a été révoqué par la rotation.
  const old = t.browser();
  old.jar.set('__Host-relay_session', before);
  assert.equal((await old.call('GET', '/api/data')).status, 401);
  assert.equal((await (await mac.call('GET', '/auth/sessions')).json()).sessions.length, 1);
  // Réauthentification sans auth_time récent : refusée.
  const { res: stale } = await t.login(mac, { reauth: true, overrides: { claims: { auth_time: Math.floor(now / 1000) - 3600 } } });
  assert.equal((await stale.json()).code, 'reauth_failed');
  t.close();
});

test('durées : inactivité et durée absolue', async () => {
  let now = Date.now();
  const t = await setup({ clock: () => now, env: { AUTH_IDLE_TTL_HOURS: '2', AUTH_SESSION_TTL_HOURS: '5' } });
  const b = t.browser();
  await t.login(b);
  now += 90 * 60000;
  assert.equal((await b.call('GET', '/api/data')).status, 200, 'activité dans le délai');
  now += 90 * 60000;
  assert.equal((await b.call('GET', '/api/data')).status, 200, 'inactivité relancée par la requête précédente');
  now += 121 * 60000;
  assert.equal((await b.call('GET', '/api/data')).status, 401, 'inactivité dépassée');
  const c = t.browser();
  await t.login(c);
  for (let i = 0; i < 6; i++) { now += 55 * 60000; await c.call('GET', '/api/data'); }
  assert.equal((await c.call('GET', '/api/data')).status, 401, 'durée absolue dépassée malgré l’activité');
  t.close();
});

test('changement de configuration au redémarrage : sessions précédentes invalides', async () => {
  const db = new DatabaseSync(':memory:');
  const t = await setup({ db });
  const b = t.browser();
  await t.login(b);
  t.close();
  const token = b.jar.get('__Host-relay_session');
  for (const env of [{ AUTH_OWNER_SUB: 'autre-sub' }, { AUTH_MFA_ACR: 'autre-acr' }, { AUTH_CLIENT_ID: 'autre-client' }]) {
    const next = await setup({ db, env });
    const c = next.browser();
    c.jar.set('__Host-relay_session', token);
    assert.equal((await c.call('GET', '/api/data')).status, 401, JSON.stringify(env));
    next.close();
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
});

test('limite de débit sur la connexion et réponses sans cache', async () => {
  const t = await setup();
  const b = t.browser();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await b.call('GET', '/auth/login')).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(303));
  const limited = await b.call('GET', '/auth/login');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal((await b.call('GET', '/auth/callback?code=x&state=y')).status, 429, 'callback compté aussi');
  t.close();
});

test('mode désactivé (local) et refus du mode hébergé sans authentification', async () => {
  const auth = readAuthConfig({ env: {}, mode: 'local', publicBaseUrl: 'http://127.0.0.1:4310' });
  assert.equal(auth.enabled, false);
  const owner = await createOwnerAuth({ config: { mode: 'local', auth }, db: new DatabaseSync(':memory:') });
  assert.equal(owner.enabled, false);
  const out = [];
  const res = { writeHead: (s, h) => { out.push(s, h); return res; }, end: b => out.push(b) };
  assert.equal(await owner.handle({ method: 'GET' }, res, new URL('http://x/auth/session')), true);
  assert.equal(out[0], 200);
  assert.deepEqual(JSON.parse(out[2]), { enabled: false, authenticated: false });
  assert.equal(await owner.handle({ method: 'GET' }, res, new URL('http://x/auth/login')), false);
  await assert.rejects(() => createOwnerAuth({ config: { mode: 'hosted', auth }, db: new DatabaseSync(':memory:') }), /obligatoire/);
});


test('confirmation récente : auth_time absent ne prouve aucune fraîcheur et une date future est refusée',async()=>{
 const a=await setup();const b=a.browser();await a.login(b,{overrides:{drop:['auth_time']}});const info=await sessionOf(b);assert.equal(info.authenticated,true);assert.equal(info.recent,false);assert.equal((await a.mutate(b,'/api/sensitive',{csrf:info.csrfToken})).status,403);a.close();
 const c=await setup();const d=c.browser();const {res}=await c.login(d,{overrides:{claims:{auth_time:Math.floor(Date.now()/1000)+3600}}});assert.equal(res.status,401);assert.equal((await res.json()).code,'auth_time_invalid');c.close();
});

test('CSRF non ASCII : refus explicite sans exception de longueur de tampon',async()=>{
 const a=await setup();const b=a.browser();await a.login(b);assert.equal((await a.mutate(b,'/api/data',{csrf:'é'.repeat(43)})).status,403);a.close();
});
