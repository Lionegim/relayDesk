// Identité de TEST (deploy/hosted-test) : contrôles statiques et script de configuration contre une API simulée.
// Aucun Keycloak réel, aucun réseau externe. La preuve MFA réelle se lance à part (deploy/hosted-test/prove-mfa.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = p => readFileSync(new URL(`../deploy/hosted-test/${p}`, import.meta.url), 'utf8');

test('compose d’identité : images épinglées, mode production, aucun port public, base interne', () => {
  const y = read('identity.compose.yaml'), d = read('keycloak.Dockerfile');
  assert.match(y, /image: postgres:17\.11-alpine3\.24@sha256:[0-9a-f]{64}\n/);
  assert.match(d, /keycloak\/keycloak:26\.8\.1@sha256:[0-9a-f]{64}/);
  assert.match(d, /RUN \/opt\/keycloak\/bin\/kc\.sh build/);
  assert.match(y, /exec \/opt\/keycloak\/bin\/kc\.sh start --optimized/);
  assert.doesNotMatch(y + d, /start-dev|dev-file|KC_DB_PASSWORD:|KC_BOOTSTRAP_ADMIN_PASSWORD:/);
  const ports = [...y.matchAll(/^\s+- "([^"]+)"$/gm)].map(m => m[1]).filter(p => /:\d+$/.test(p));
  assert.deepEqual(ports, ['127.0.0.1:18080:8080'], 'seule l’administration est publiée, sur la boucle locale');
  assert.doesNotMatch(y, /9000:/);
  assert.match(y, /identity-db:\n {4}internal: true/);
  assert.match(y, /keycloak-db:[\s\S]*?networks: \[identity-db\]/);
  assert.match(y, /KC_HOSTNAME_STRICT: "true"/);
  assert.match(y, /KC_HOSTNAME_ADMIN: http:\/\/127\.0\.0\.1:18080/);
  assert.match(y, /KC_PROXY_HEADERS: xforwarded/);
  assert.match(y, /KC_PROXY_TRUSTED_ADDRESSES: \$\{IDENTITY_TRUSTED_PROXIES:\?/);
  for (const s of ['postgres_password', 'keycloak_db_password', 'kc_bootstrap_admin_user', 'kc_bootstrap_admin_password']) assert.match(y, new RegExp(`${s}:\\n {4}file: \\$\\{IDENTITY_SECRETS_DIR:\\?[^}]*\\}/${s}\\n`), s);
  assert.match(y, /\$\$\(< \/run\/secrets\/keycloak_db_password\)/, '$ échappé pour Compose');
  const mem = [...y.matchAll(/mem_limit: (\d+)m/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.ok(mem <= 2048, `mémoire de l’identité ${mem} Mio`);
  for (const svc of ['keycloak-db', 'keycloak']) {
    const block = y.slice(y.indexOf(`\n  ${svc}:\n`) + 1).split(/\n {2}[a-z-]+:\n/)[0];
    assert.match(block, /read_only: true/, svc);
    assert.match(block, /cap_drop: \[ALL\]/, svc);
  }
});

test('extrait Caddy : seuls le realm de test et les ressources sont publics, console de compte exclue', () => {
  const c = read('identity.caddy');
  const matcher = c.slice(c.indexOf('@public {'), c.indexOf('}', c.indexOf('@public {')));
  assert.match(matcher, /path \/realms\/relay-test\/\* \/resources\/\*/);
  assert.match(matcher, /not path \/realms\/relay-test\/account \/realms\/relay-test\/account\/\*/);
  assert.match(c, /handle \{\n\t\trespond 404\n\t\}/);
  assert.doesNotMatch(c, /respond @account/, 'handle passe avant respond : l’exclusion doit être dans le matcher');
  const code = c.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\/admin|master|9000/);
});

test('TOTP RFC 6238 (SHA-1) et base32', async () => {
  const { totp, base32, otpauthUri } = await import('../deploy/hosted-test/lib.mjs');
  const s = '12345678901234567890';
  assert.deepEqual([59000, 1111111109000, 20000000000000].map(time => totp(s, { time, digits: 8 })), ['94287082', '07081804', '65353130']);
  assert.equal(base32(Buffer.from(s)), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.match(otpauthUri({ secretValue: s, account: 'owner-test', issuer: 'relay-test' }), /^otpauth:\/\/totp\/relay-test%3Aowner-test\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=relay-test&algorithm=SHA1&digits=6&period=30$/);
});

// API d'administration Keycloak simulée : enregistre les appels et répond comme Keycloak pour ce parcours.
// realmName : realm visé par le script ; ses chemins sont ramenés à ceux du realm de test simulé.
function fakeKeycloak(realmName = 'relay-test') {
  const calls = [], flows = new Map([['relay browser loa', []]]);
  let realm = null, client = null, user = null, nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const json = body && req.headers['content-type']?.includes('json') ? JSON.parse(body) : body;
      const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname).replace(new RegExp(`^/admin/realms/${realmName}(?=/|$)`), '/admin/realms/relay-test');
      calls.push({ method: req.method, path: p, body: json });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (p === '/realms/master/protocol/openid-connect/token') return send(200, { access_token: 'jeton-admin-fictif' });
      if (req.headers.authorization !== 'Bearer jeton-admin-fictif') return send(401);
      if (p === '/admin/realms/relay-test' && req.method === 'GET') return realm ? send(200, realm) : send(404);
      if (p === '/admin/realms/relay-test' && req.method === 'DELETE') { realm = null; return send(204); }
      if (p === '/admin/realms' && req.method === 'POST') { realm = json; return send(201); }
      if (p === '/admin/realms/relay-test' && req.method === 'PUT') { realm = { ...realm, ...json }; return send(204); }
      let m;
      if (p === '/admin/realms/relay-test/authentication/flows' && req.method === 'POST') return send(201);
      if ((m = p.match(/^\/admin\/realms\/relay-test\/authentication\/flows\/(.+)\/executions(\/(flow|execution))?$/))) {
        const list = flows.get(m[1]) || [];
        if (req.method === 'GET') return send(200, list);
        if (req.method === 'POST') {
          const e = { id: id(), level: 0, requirement: 'DISABLED', ...(m[3] === 'flow' ? { displayName: json.alias, authenticationFlow: true } : { providerId: json.provider }) };
          list.push(e); flows.set(m[1], list);
          if (m[3] === 'flow') flows.set(json.alias, []);
          return send(201);
        }
        if (req.method === 'PUT') { Object.assign(list.find(e => e.id === json.id), { requirement: json.requirement }); return send(204); }
      }
      if (/\/authentication\/executions\/[^/]+\/config$/.test(p)) return send(201);
      if (p === '/admin/realms/relay-test/clients' && req.method === 'POST') { client = { ...json, id: id() }; return send(201); }
      if (p === '/admin/realms/relay-test/clients' && req.method === 'GET') return send(200, client ? [client] : []);
      if (p === '/admin/realms/relay-test/client-scopes') return send(200, [{ id: 'scope-acr', name: 'acr', protocol: 'openid-connect' }]);
      if (p.endsWith('/default-client-scopes') && req.method === 'GET') return send(200, []);
      if (p.endsWith('/default-client-scopes/scope-acr') && req.method === 'PUT') return send(204);
      if (p === '/admin/realms/relay-test/partialImport') { user = { ...json.users[0], id: id() }; return send(200, { added: 1 }); }
      if (p === '/admin/realms/relay-test/users') return send(200, user ? [{ id: user.id, username: user.username }] : []);
      if (user && p === `/admin/realms/relay-test/users/${user.id}` && req.method === 'GET') return send(200, { id: user.id, username: user.username, requiredActions: user.requiredActions });
      if (p.endsWith('/credentials')) return send(200, user.credentials.map(c => ({ type: c.type })));
      return send(404);
    });
  });
  return { server, calls, flows, get realm() { return realm; }, get client() { return client; }, get user() { return user; } };
}

test('configuration Keycloak : realm, flux par niveaux, client confidentiel PKCE, propriétaire avec OTP, aucun secret affiché', async t => {
  const { configureKeycloak, FLOW } = await import('../deploy/hosted-test/configure-keycloak.mjs');
  const kc = fakeKeycloak();
  await new Promise(r => kc.server.listen(0, '127.0.0.1', r));
  t.after(() => kc.server.close());
  const root = mkdtempSync(join(tmpdir(), 'relay-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'out'), logs = [];
  const base = { adminUrl: `http://127.0.0.1:${kc.server.address().port}`, adminUser: 'admin-fictif', adminPassword: 'mot-de-passe-admin-fictif', publicUrl: 'https://relay.example.test', issuerBase: 'https://auth.relay.example.test', out };
  const r = await configureKeycloak(base, { log: m => logs.push(m) });

  // Realm : aucune inscription, force brute, OTP TOTP, correspondance acr → LoA 2, flux navigateur dédié.
  assert.equal(kc.realm.registrationAllowed, false);
  assert.equal(kc.realm.resetPasswordAllowed, false);
  assert.equal(kc.realm.bruteForceProtected, true);
  assert.equal(kc.realm.sslRequired, 'all');
  assert.equal(kc.realm.otpPolicyType, 'totp');
  assert.equal(kc.realm.otpPolicyCodeReusable, false);
  assert.deepEqual(JSON.parse(kc.realm.attributes['acr.loa.map']), { 'relay-mfa': 2 });
  assert.equal(kc.realm.browserFlow, FLOW);
  const req = alias => kc.flows.get(alias).map(e => `${e.providerId || e.displayName}:${e.requirement}`);
  assert.deepEqual(req(FLOW), ['auth-cookie:ALTERNATIVE', 'relay forms:ALTERNATIVE']);
  assert.deepEqual(req('relay forms'), ['relay loa1:CONDITIONAL', 'relay loa2:CONDITIONAL']);
  assert.deepEqual(req('relay loa1'), ['conditional-level-of-authentication:REQUIRED', 'auth-username-password-form:REQUIRED']);
  assert.deepEqual(req('relay loa2'), ['conditional-level-of-authentication:REQUIRED', 'auth-otp-form:REQUIRED']);
  const configs = kc.calls.filter(c => c.path.endsWith('/config')).map(c => c.body.config);
  assert.deepEqual(configs, [{ 'loa-condition-level': '1', 'loa-max-age': '36000' }, { 'loa-condition-level': '2', 'loa-max-age': '0' }]);

  // Client : confidentiel, code + PKCE S256 seulement, retour exact, minimum acr imposé.
  const c = kc.client;
  assert.deepEqual([c.publicClient, c.standardFlowEnabled, c.implicitFlowEnabled, c.directAccessGrantsEnabled, c.serviceAccountsEnabled], [false, true, false, false, false]);
  assert.deepEqual(c.redirectUris, ['https://relay.example.test/auth/callback']);
  assert.deepEqual(c.webOrigins, []);
  assert.equal(c.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(c.attributes['minimum.acr.value'], 'relay-mfa');
  assert.ok(kc.calls.some(x => x.method === 'PUT' && x.path.endsWith('/default-client-scopes/scope-acr')), 'scope acr ajouté');

  // Propriétaire fictif : mot de passe et OTP importés, aucune action requise.
  assert.equal(kc.user.username, 'owner-test');
  assert.deepEqual(kc.user.requiredActions, []);
  assert.deepEqual(kc.user.credentials.map(x => x.type), ['password', 'otp']);
  assert.deepEqual(JSON.parse(kc.user.credentials[1].credentialData), { subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' });

  // Fichiers 0400 dans un répertoire 0700 ; secrets neufs et absents des journaux.
  assert.equal(statSync(out).mode & 0o777, 0o700);
  const files = ['relay/auth_client_id', 'relay/auth_client_secret', 'relay/auth.env', 'owner/username', 'owner/password', 'owner/otp-secret', 'owner/otpauth-uri'];
  for (const f of files) assert.equal(statSync(join(out, f)).mode & 0o777, 0o400, f);
  const secret = readFileSync(join(out, 'relay/auth_client_secret'), 'utf8').trim(), pw = readFileSync(join(out, 'owner/password'), 'utf8').trim(), otp = readFileSync(join(out, 'owner/otp-secret'), 'utf8').trim();
  assert.equal(secret, c.secret);
  assert.ok(secret.length >= 40 && pw.length === 24 && otp.length === 32);
  assert.equal(readFileSync(join(out, 'relay/auth.env'), 'utf8'), `AUTH_ISSUER=https://auth.relay.example.test/realms/relay-test\nAUTH_OWNER_SUB=${r.sub}\nAUTH_MFA_ACR=relay-mfa\n`);
  for (const v of [secret, pw, otp, 'mot-de-passe-admin-fictif']) assert.ok(!logs.join('\n').includes(v));

  // Relance : realm existant refusé sans --recreate, répertoire de sortie non vide refusé.
  await assert.rejects(configureKeycloak({ ...base, out: join(root, 'out2') }), /existe déjà/);
  await assert.rejects(configureKeycloak({ ...base }), /absent ou vide/);
  const again = await configureKeycloak({ ...base, out: join(root, 'out3'), recreate: true }, { log: () => {} });
  assert.ok(again.sub);
  assert.notEqual(readFileSync(join(root, 'out3/relay/auth_client_secret'), 'utf8'), readFileSync(join(out, 'relay/auth_client_secret'), 'utf8'), 'nouveaux secrets');
  assert.ok(readdirSync(join(root, 'out2')).length === 0);
});

test('configuration Keycloak : administration en boucle locale seulement, hôtes et realm contrôlés', async () => {
  const { configureKeycloak } = await import('../deploy/hosted-test/configure-keycloak.mjs');
  const out = join(tmpdir(), `relay-identity-refus-${process.pid}`);
  const base = { adminUrl: 'http://127.0.0.1:1', adminUser: 'a', adminPassword: 'b', publicUrl: 'https://relay.example.test', issuerBase: 'https://auth.relay.example.test', out };
  await assert.rejects(configureKeycloak({ ...base, adminUrl: 'https://auth.relay.example.test' }), /boucle locale/);
  await assert.rejects(configureKeycloak({ ...base, issuerBase: 'https://relay.example.test' }), /autre hôte/);
  await assert.rejects(configureKeycloak({ ...base, realm: 'master' }), /realm invalide/);
  await assert.rejects(configureKeycloak({ ...base, publicUrl: 'https://relay.example.test/app' }), /origine sans chemin/);
  await assert.rejects(configureKeycloak({ ...base, out: new URL('../deploy', import.meta.url).pathname }), /dans le dépôt/);
  assert.equal(existsSync(out), false, 'aucun répertoire créé avant les contrôles');
});

test('enrôlement du propriétaire : realm distinct, aucun facteur permanent généré ni exporté, actions imposées', async t => {
  const { configureKeycloak, ENROLMENT_ACTIONS } = await import('../deploy/hosted-test/configure-keycloak.mjs');
  const kc = fakeKeycloak('relay');
  await new Promise(r => kc.server.listen(0, '127.0.0.1', r));
  t.after(() => kc.server.close());
  const root = mkdtempSync(join(tmpdir(), 'relay-enrol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'out'), logs = [];
  const base = { adminUrl: `http://127.0.0.1:${kc.server.address().port}`, adminUser: 'admin-fictif', adminPassword: 'mot-de-passe-admin-fictif', publicUrl: 'https://relay.example.test', issuerBase: 'https://auth.relay.example.test', out, enrolment: true };
  const r = await configureKeycloak(base, { log: m => logs.push(m) });

  // Realm et client distincts du test : realm « relay », même politique MFA, nouveau secret de client.
  assert.ok(kc.calls.some(c => c.method === 'POST' && c.path === '/admin/realms' && c.body.realm === 'relay'));
  assert.equal(kc.realm.realm, 'relay');
  assert.equal(kc.realm.registrationAllowed, false);
  assert.deepEqual(JSON.parse(kc.realm.attributes['acr.loa.map']), { 'relay-mfa': 2 });
  assert.equal(kc.client.attributes['minimum.acr.value'], 'relay-mfa');
  assert.equal(kc.client.directAccessGrantsEnabled, false);

  // Propriétaire : un seul identifiant, temporaire ; aucun OTP ; actions imposées.
  assert.equal(kc.user.username, 'owner');
  assert.deepEqual(kc.user.credentials.map(c => [c.type, c.temporary]), [['password', true]]);
  assert.deepEqual(kc.user.requiredActions, ['UPDATE_PASSWORD', 'CONFIGURE_TOTP', 'VERIFY_PROFILE']);
  assert.deepEqual([...ENROLMENT_ACTIONS], kc.user.requiredActions);
  assert.equal(kc.user.firstName ?? kc.user.lastName ?? kc.user.email ?? null, null, 'aucune donnée personnelle écrite');

  // Sorties : aucun facteur permanent (ni mot de passe définitif, ni secret OTP, ni URI otpauth).
  const files = [];
  const walk = d => readdirSync(join(out, d), { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)));
  walk('.');
  assert.deepEqual(files.map(f => f.replace(/^\.\//, '')).sort(), ['owner/temporary-password', 'owner/username', 'relay/auth.env', 'relay/auth_client_id', 'relay/auth_client_secret']);
  for (const f of files) assert.equal(statSync(join(out, f)).mode & 0o777, 0o400, f);
  const temp = readFileSync(join(out, 'owner/temporary-password'), 'utf8').trim();
  assert.equal(temp, kc.user.credentials[0].value);
  assert.equal(readFileSync(join(out, 'relay/auth.env'), 'utf8'), `AUTH_ISSUER=https://auth.relay.example.test/realms/relay\nAUTH_OWNER_SUB=${r.sub}\nAUTH_MFA_ACR=relay-mfa\n`);
  for (const v of [temp, kc.client.secret, 'mot-de-passe-admin-fictif']) assert.ok(!logs.join('\n').includes(v));

  // Refus : realm de test, recréation d'un realm réel, realm existant.
  await assert.rejects(configureKeycloak({ ...base, out: join(root, 'o2'), realm: 'relay-test' }), /realm distinct du realm de test/);
  await assert.rejects(configureKeycloak({ ...base, out: join(root, 'o3'), recreate: true }), /--recreate est refusé avec --enrolment/);
  await assert.rejects(configureKeycloak({ ...base, out: join(root, 'o4') }), /existe déjà/);
  await assert.rejects(configureKeycloak({ ...base, enrolment: false, realm: 'relay', out: join(root, 'o5'), recreate: true }), /réservé au realm fictif relay-test/);
  assert.equal(existsSync(join(root, 'o5')),false,'refus avant accès au disque ou à Keycloak');
  assert.equal(kc.calls.filter(c => c.method === 'DELETE').length, 0, 'aucun realm supprimé, même en cas d’oubli du flag enrolment');
});

test('mode synthétique inchangé : realm relay-test et propriétaire fictif par défaut', async () => {
  const { ownerRepresentation, enrolmentOwnerRepresentation } = await import('../deploy/hosted-test/configure-keycloak.mjs');
  const fict = ownerRepresentation({ username: 'owner-test', password: 'p', otpSecret: 's' });
  assert.deepEqual(fict.credentials.map(c => c.type), ['password', 'otp']);
  assert.deepEqual(fict.requiredActions, []);
  const enrol = enrolmentOwnerRepresentation({ username: 'owner', temporaryPassword: 't' });
  assert.ok(!enrol.credentials.some(c => c.type === 'otp' || c.temporary === false));
});
