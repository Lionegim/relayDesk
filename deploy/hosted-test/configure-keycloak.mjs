// Configure le realm de TEST de Relay Desk dans Keycloak via l'API d'administration, en boucle locale uniquement.
// Crée : realm sans inscription ni grant direct, MFA OTP obligatoire par niveaux (LoA 2 = acr « relay-mfa »),
// client confidentiel PKCE S256 avec retour exact, et un propriétaire FICTIF avec mot de passe et OTP neufs.
// Les secrets générés sont écrits dans --out (hors dépôt, fichiers 0400) ; rien de secret n'est affiché.
//
//   node deploy/hosted-test/configure-keycloak.mjs \
//     --admin-url http://127.0.0.1:8081 \
//     --admin-user-file /etc/relay-identity/secrets/kc_bootstrap_admin_user \
//     --admin-password-file /etc/relay-identity/secrets/kc_bootstrap_admin_password \
//     --public-url https://relay.noegim.com \
//     --issuer-base https://auth.relay.noegim.com \
//     --out /root/relay-identity-test-out
//
// Options : --realm (relay-test), --client-id (relay-desk), --owner (owner-test), --acr (relay-mfa),
//           --ssl-required (all), --recreate (supprime puis recrée le realm de test : nouveaux secrets).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomAlnum, randomSecret, otpauthUri, isLoopbackUrl, prepareOutputDir, writePrivate, readSecretFile, parseArgs } from './lib.mjs';

export const FLOW = 'relay browser loa';
export const OTP_POLICY = Object.freeze({ type: 'totp', algorithm: 'HmacSHA1', digits: 6, period: 30 });

// Représentations envoyées à Keycloak (exportées pour les tests).
export function realmSettings({ realm, acr, sslRequired }) {
  return {
    realm, enabled: true, displayName: 'Relay Desk (test)', sslRequired,
    registrationAllowed: false, registrationEmailAsUsername: false, resetPasswordAllowed: false, rememberMe: false,
    editUsernameAllowed: false, loginWithEmailAllowed: false, duplicateEmailsAllowed: false, verifyEmail: false,
    bruteForceProtected: true, permanentLockout: false, failureFactor: 5, waitIncrementSeconds: 60,
    maxFailureWaitSeconds: 900, maxDeltaTimeSeconds: 43200, quickLoginCheckMilliSeconds: 1000, minimumQuickLoginWaitSeconds: 60,
    passwordPolicy: 'length(14) and notUsername and notEmail',
    otpPolicyType: OTP_POLICY.type, otpPolicyAlgorithm: OTP_POLICY.algorithm, otpPolicyDigits: OTP_POLICY.digits,
    otpPolicyPeriod: OTP_POLICY.period, otpPolicyLookAheadWindow: 1, otpPolicyCodeReusable: false,
    accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 36000,
    // Correspondance standard ACR → niveau : le claim acr vient du mappeur « acr loa level », jamais d'une valeur fixe.
    attributes: { 'acr.loa.map': JSON.stringify({ [acr]: 2 }) },
  };
}

export function clientSettings({ clientId, secret, publicUrl, acr }) {
  const origin = new URL(publicUrl).origin;
  return {
    clientId, name: 'Relay Desk (test)', enabled: true, protocol: 'openid-connect',
    publicClient: false, clientAuthenticatorType: 'client-secret', secret,
    standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false, authorizationServicesEnabled: false, consentRequired: false,
    frontchannelLogout: false, fullScopeAllowed: false, bearerOnly: false,
    redirectUris: [`${origin}/auth/callback`], webOrigins: [], rootUrl: origin, baseUrl: '/',
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'minimum.acr.value': acr,
      'default.acr.values': acr,
      'oauth2.device.authorization.grant.enabled': 'false',
      'oidc.ciba.grant.enabled': 'false',
      'standard.token.exchange.enabled': 'false',
      'post.logout.redirect.uris': '',
      'backchannel.logout.session.required': 'false',
    },
  };
}

export function ownerRepresentation({ username, password, otpSecret }) {
  return {
    username, enabled: true, emailVerified: true,
    email: `${username}@relay-test.invalid`, firstName: 'Propriétaire', lastName: 'Fictif',
    requiredActions: [],
    credentials: [
      { type: 'password', value: password, temporary: false },
      {
        type: 'otp', userLabel: 'relay-test',
        secretData: JSON.stringify({ value: otpSecret }),
        credentialData: JSON.stringify({ subType: OTP_POLICY.type, digits: OTP_POLICY.digits, counter: 0, period: OTP_POLICY.period, algorithm: OTP_POLICY.algorithm }),
      },
    ],
  };
}

// Flux navigateur par niveaux : niveau 1 = mot de passe, niveau 2 = OTP (âge maximal 0 : OTP à chaque authentification de niveau 2).
export const FLOW_PLAN = Object.freeze([
  { kind: 'execution', parent: FLOW, provider: 'auth-cookie', requirement: 'ALTERNATIVE' },
  { kind: 'flow', parent: FLOW, alias: 'relay forms', requirement: 'ALTERNATIVE' },
  { kind: 'flow', parent: 'relay forms', alias: 'relay loa1', requirement: 'CONDITIONAL' },
  { kind: 'execution', parent: 'relay loa1', provider: 'conditional-level-of-authentication', requirement: 'REQUIRED', config: { alias: 'relay-loa1', config: { 'loa-condition-level': '1', 'loa-max-age': '36000' } } },
  { kind: 'execution', parent: 'relay loa1', provider: 'auth-username-password-form', requirement: 'REQUIRED' },
  { kind: 'flow', parent: 'relay forms', alias: 'relay loa2', requirement: 'CONDITIONAL' },
  { kind: 'execution', parent: 'relay loa2', provider: 'conditional-level-of-authentication', requirement: 'REQUIRED', config: { alias: 'relay-loa2', config: { 'loa-condition-level': '2', 'loa-max-age': '0' } } },
  { kind: 'execution', parent: 'relay loa2', provider: 'auth-otp-form', requirement: 'REQUIRED' },
]);

class AdminApi {
  constructor(base, fetchImpl) { this.base = base.replace(/\/$/, ''); this.fetch = fetchImpl; this.token = null; }
  async login(username, password) {
    const res = await this.fetch(`${this.base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
    });
    if (!res.ok) throw new Error(`connexion administrateur refusée (HTTP ${res.status}).`);
    this.token = (await res.json()).access_token;
  }
  async call(method, path, body, { allow = [] } = {}) {
    const res = await this.fetch(`${this.base}/admin${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(res.status)) return { status: res.status, data: null, res };
    if (!res.ok) {
      // Erreur Keycloak : seul le champ d'erreur générique est repris, jamais le corps envoyé.
      let detail = '';
      try { const j = await res.json(); detail = typeof j.errorMessage === 'string' ? j.errorMessage : typeof j.error === 'string' ? j.error : ''; } catch { /* sans corps */ }
      throw new Error(`${method} ${path.replace(/\/[0-9a-f-]{36}/g, '/…')} : HTTP ${res.status}${detail ? ` (${detail.slice(0, 120)})` : ''}.`);
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, res };
  }
}

const enc = encodeURIComponent;

export async function configureKeycloak(opts, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const { adminUrl, adminUser, adminPassword, publicUrl, issuerBase, out, realm = 'relay-test', clientId = 'relay-desk', owner = 'owner-test', acr = 'relay-mfa', sslRequired = 'all', recreate = false } = opts;
  if (!isLoopbackUrl(adminUrl)) throw new Error('--admin-url doit viser la boucle locale (127.0.0.1, localhost ou [::1]) : l’administration n’est jamais publique.');
  let pub;
  try { pub = new URL(publicUrl); } catch { throw new Error('--public-url invalide.'); }
  if (pub.protocol !== 'https:' && sslRequired !== 'none') throw new Error('--public-url doit être en HTTPS.');
  if (pub.pathname !== '/' || pub.search || pub.hash) throw new Error('--public-url doit être une origine sans chemin.');
  let idp;
  try { idp = new URL(issuerBase); } catch { throw new Error('--issuer-base invalide.'); }
  if ((idp.protocol !== 'https:' && sslRequired !== 'none') || idp.pathname !== '/' || idp.search || idp.hash) throw new Error('--issuer-base doit être une origine HTTPS sans chemin.');
  if (idp.host === pub.host) throw new Error('--issuer-base doit être un autre hôte que Relay Desk.');
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(realm) || realm === 'master') throw new Error('--realm invalide (jamais master).');
  if (!['all', 'external', 'none'].includes(sslRequired)) throw new Error('--ssl-required : all, external ou none.');
  prepareOutputDir(out);

  const api = new AdminApi(adminUrl, fetchImpl);
  await api.login(adminUser, adminPassword);

  const existing = await api.call('GET', `/realms/${enc(realm)}`, undefined, { allow: [404] });
  if (existing.status !== 404) {
    if (!recreate) throw new Error(`le realm ${realm} existe déjà : relancer avec --recreate pour le recréer (nouveaux secrets).`);
    await api.call('DELETE', `/realms/${enc(realm)}`);
    log(`Realm ${realm} supprimé (--recreate).`);
  }

  // 1. Realm et politiques.
  await api.call('POST', '/realms', { realm, enabled: true });
  await api.call('PUT', `/realms/${enc(realm)}`, realmSettings({ realm, acr, sslRequired }));

  // 2. Flux navigateur par niveaux d'authentification, lié au realm.
  const r = `/realms/${enc(realm)}`;
  await api.call('POST', `${r}/authentication/flows`, { alias: FLOW, description: 'Relay Desk : mot de passe (LoA 1) puis OTP (LoA 2)', providerId: 'basic-flow', topLevel: true, builtIn: false });
  for (const step of FLOW_PLAN) {
    const before = (await api.call('GET', `${r}/authentication/flows/${enc(step.parent)}/executions`)).data.map(e => e.id);
    if (step.kind === 'flow') await api.call('POST', `${r}/authentication/flows/${enc(step.parent)}/executions/flow`, { alias: step.alias, type: 'basic-flow', provider: 'registration-page-form', description: step.alias });
    else await api.call('POST', `${r}/authentication/flows/${enc(step.parent)}/executions/execution`, { provider: step.provider });
    const created = (await api.call('GET', `${r}/authentication/flows/${enc(step.parent)}/executions`)).data.find(e => !before.includes(e.id) && e.level === 0);
    if (!created) throw new Error(`étape de flux introuvable après création (${step.alias || step.provider}).`);
    await api.call('PUT', `${r}/authentication/flows/${enc(step.parent)}/executions`, { ...created, requirement: step.requirement });
    if (step.config) await api.call('POST', `${r}/authentication/executions/${enc(created.id)}/config`, step.config);
  }
  await api.call('PUT', r, { ...realmSettings({ realm, acr, sslRequired }), browserFlow: FLOW });

  // 3. Client confidentiel : secret neuf, PKCE S256, retour exact, aucun grant direct ni implicite.
  const clientSecret = randomSecret(32);
  await api.call('POST', `${r}/clients`, clientSettings({ clientId, secret: clientSecret, publicUrl: pub.origin, acr }));
  const client = (await api.call('GET', `${r}/clients?clientId=${enc(clientId)}`)).data[0];
  if (!client) throw new Error('client introuvable après création.');
  // Le scope « acr » (mappeur acr loa level) doit être un scope par défaut du client.
  const scopes = (await api.call('GET', `${r}/client-scopes`)).data;
  const acrScope = scopes.find(s => s.name === 'acr' && s.protocol === 'openid-connect');
  if (!acrScope) throw new Error('scope client « acr » absent du realm.');
  const defaults = (await api.call('GET', `${r}/clients/${enc(client.id)}/default-client-scopes`)).data;
  if (!defaults.some(s => s.id === acrScope.id)) await api.call('PUT', `${r}/clients/${enc(client.id)}/default-client-scopes/${enc(acrScope.id)}`);

  // 4. Propriétaire fictif : mot de passe et OTP neufs, importés (aucune action requise au premier accès).
  const password = randomAlnum(24), otpSecret = randomAlnum(32);
  await api.call('POST', `${r}/partialImport`, { ifResourceExists: 'FAIL', users: [ownerRepresentation({ username: owner, password, otpSecret })] });
  const user = (await api.call('GET', `${r}/users?username=${enc(owner)}&exact=true`)).data[0];
  if (!user?.id) throw new Error('propriétaire introuvable après import.');
  const creds = (await api.call('GET', `${r}/users/${enc(user.id)}/credentials`)).data.map(c => c.type).sort();
  if (creds.join(',') !== 'otp,password') throw new Error('identifiants du propriétaire incomplets après import.');

  // 5. Fichiers de sortie (0400), puis résumé sans secret.
  const issuer = `${idp.origin}/realms/${realm}`;
  writePrivate(out, 'relay/auth_client_id', clientId);
  writePrivate(out, 'relay/auth_client_secret', clientSecret);
  writePrivate(out, 'relay/auth.env', [
    `AUTH_ISSUER=${issuer}`,
    `AUTH_OWNER_SUB=${user.id}`,
    `AUTH_MFA_ACR=${acr}`,
  ].join('\n'));
  writePrivate(out, 'owner/username', owner);
  writePrivate(out, 'owner/password', password);
  writePrivate(out, 'owner/otp-secret', otpSecret);
  writePrivate(out, 'owner/otpauth-uri', otpauthUri({ secretValue: otpSecret, account: owner, issuer: realm }));
  log(`Realm ${realm} configuré : inscription, grant direct et implicite désactivés ; MFA OTP obligatoire (acr ${acr} = LoA 2).`);
  log(`Client ${clientId} : confidentiel, PKCE S256, retour ${pub.origin}/auth/callback.`);
  log(`Propriétaire fictif ${owner} : sub ${user.id}.`);
  log(`Secrets écrits (0400) dans ${out} : relay/auth_client_id, relay/auth_client_secret, relay/auth.env, owner/*.`);
  return { sub: user.id, clientUuid: client.id, issuer };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2), {
      'admin-url': 'value', 'admin-user-file': 'value', 'admin-password-file': 'value', 'public-url': 'value', 'issuer-base': 'value',
      out: 'value', realm: 'value', 'client-id': 'value', owner: 'value', acr: 'value', 'ssl-required': 'value', recreate: 'flag',
    });
    for (const k of ['admin-url', 'admin-user-file', 'admin-password-file', 'public-url', 'issuer-base', 'out']) if (!a[k]) throw new Error(`--${k} est requis.`);
    await configureKeycloak({
      adminUrl: a['admin-url'], adminUser: readSecretFile(a['admin-user-file'], '--admin-user-file'),
      adminPassword: readSecretFile(a['admin-password-file'], '--admin-password-file'),
      publicUrl: a['public-url'], issuerBase: a['issuer-base'], out: a.out, realm: a.realm, clientId: a['client-id'], owner: a.owner,
      acr: a.acr, sslRequired: a['ssl-required'], recreate: !!a.recreate,
    });
  } catch (e) {
    console.error(`Configuration refusée : ${e.message}`);
    process.exit(1);
  }
}
