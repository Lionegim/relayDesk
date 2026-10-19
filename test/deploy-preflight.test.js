// Préflight de déploiement hébergé (deploy/preflight.mjs) sur configurations entièrement fictives.
// Aucun service démarré, aucun réseau : répertoires temporaires, domaines réservés aux tests, clés jetables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Le stage Docker de tests ne contient que src/, public/ et test/ : ces contrôles d'hôte y sont ignorés.
const available = existsSync(new URL('../deploy/preflight.mjs', import.meta.url));
const skip = available ? false : 'deploy/ absent de ce contexte (stage Docker de tests)';
const load = async () => ({ ...(await import('../deploy/preflight.mjs')), ...(await import('../deploy/fictif/make-hosting.mjs')) });
const uid = process.getuid();

async function setup(t, edit = {}) {
  const { makeFictiveHosting, preflight } = await load();
  const root = mkdtempSync(join(tmpdir(), 'relay-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = makeFictiveHosting(join(root, 'h'), { uid });
  let env = readFileSync(out.envFile, 'utf8');
  for (const [k, v] of Object.entries(edit)) env = v === null ? env.replace(new RegExp(`^${k}=.*\\n`, 'm'), '') : new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env}${k}=${v}\n`;
  writeFileSync(out.envFile, env);
  const run = opts => preflight({ envFile: out.envFile, uid, fictif: true, ...opts });
  return { ...out, root, run };
}
const has = (list, re) => list.some(m => re.test(m));

test('configuration fictive complète : acceptée, y compris par la validation du runtime', { skip }, async t => {
  const { run } = await setup(t);
  const r = await run();
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.notes, /validation du runtime/));
  assert.ok(has(r.notes, /fictive, non déployable/));
});

test('sans --fictif, les domaines réservés aux tests sont refusés ; avec --fictif, un vrai domaine aussi', { skip }, async t => {
  const { run } = await setup(t);
  const r = await run({ fictif: false });
  assert.ok(has(r.errors, /RELAY_DOMAIN utilise un domaine réservé/));
  assert.ok(has(r.errors, /AUTH_ISSUER utilise un domaine réservé/));
  const real = await setup(t, { RELAY_DOMAIN: 'relay.anove.ai', PUBLIC_BASE_URL: 'https://relay.anove.ai' });
  assert.ok(has((await real.run()).errors, /--fictif exige un domaine réservé/));
});

test('aucun secret ni valeur de modèle dans le fichier d’environnement ; aucune valeur affichée', { skip }, async t => {
  const { run } = await setup(t, { AUTH_CLIENT_SECRET: 'fictif-valeur-sensible', MISTRAL_API_KEY: 'fictif-cle', AUTH_OWNER_SUB: 'A_RENSEIGNER' });
  const r = await run();
  assert.ok(has(r.errors, /^AUTH_CLIENT_SECRET : les secrets se fournissent en fichiers/));
  assert.ok(has(r.errors, /^MISTRAL_API_KEY : les secrets/));
  assert.ok(has(r.errors, /AUTH_OWNER_SUB : valeur de modèle/));
  assert.doesNotMatch(JSON.stringify(r), /fictif-valeur-sensible|fictif-cle/);
});

test('origine publique, étiquette d’image, ACME et émetteur Keycloak', { skip }, async t => {
  const a = await (await setup(t, { PUBLIC_BASE_URL: 'https://relay.example.test/', RELAY_IMAGE_TAG: 'latest', ACME_CA: 'http://acme.example.test' })).run();
  assert.ok(has(a.errors, /PUBLIC_BASE_URL doit valoir exactement/));
  assert.ok(has(a.errors, /RELAY_IMAGE_TAG/));
  assert.ok(has(a.errors, /ACME_CA doit être une URL HTTPS/));
  const b = await (await setup(t, { AUTH_ISSUER: 'https://relay.example.test/realms/relay', AUTH_MFA_ACR: '1', AUTH_OWNER_SUB: 'jean@example.test' })).run();
  assert.ok(has(b.errors, /AUTH_ISSUER doit être servi par un autre hôte/));
  assert.ok(has(b.warnings, /AUTH_MFA_ACR/));
  assert.ok(has(b.warnings, /AUTH_OWNER_SUB n’a pas la forme/));
  const c = await (await setup(t, { RELAY_DOMAIN: '192.0.2.10', PUBLIC_BASE_URL: 'https://192.0.2.10' })).run();
  assert.ok(has(c.errors, /nom de domaine complet/));
});

test('valeurs de modèle : marqueurs explicites refusés, suites aléatoires acceptées', { skip }, async t => {
  // Une clé aléatoire peut contenir « xXx » ou « ToDo » : seuls les marqueurs explicites ou les valeurs entières génériques sont refusés.
  const s = await setup(t, { AUTH_MFA_ACR: 'relay-mfa-xXxToDo' });
  chmodSync(join(s.secrets, 'mistral_api_key'), 0o600);
  writeFileSync(join(s.secrets, 'mistral_api_key'), 'abcXxXtodo123');
  chmodSync(join(s.secrets, 'mistral_api_key'), 0o400);
  assert.deepEqual((await s.run()).errors, []);
  const generic = await setup(t, { AUTH_MFA_ACR: 'TODO' });
  assert.ok(has((await generic.run()).errors, /AUTH_MFA_ACR : valeur de modèle/));
});

test('variables obligatoires et doublons', { skip }, async t => {
  const s = await setup(t, { RELAY_DATA_DIR: null, RELAY_BACKUP_KEY_FILE: null });
  writeFileSync(s.envFile, readFileSync(s.envFile, 'utf8') + 'ACME_EMAIL=autre@example.test\n');
  const r = await s.run();
  assert.ok(has(r.errors, /RELAY_DATA_DIR est requis/));
  assert.ok(has(r.errors, /RELAY_BACKUP_KEY_FILE est requis/));
  assert.ok(has(r.errors, /ACME_EMAIL défini plusieurs fois/));
});

test('secrets : présence, mode 0400, liens refusés, valeurs de modèle, clé du coffre bien formée', { skip }, async t => {
  const s = await setup(t);
  chmodSync(join(s.secrets, 'mistral_api_key'), 0o644);
  unlinkSync(join(s.secrets, 'google_web_client_secret'));
  chmodSync(join(s.secrets, 'relay_secret_key'), 0o600);
  writeFileSync(join(s.secrets, 'relay_secret_key'), 'courte');
  chmodSync(join(s.secrets, 'relay_secret_key'), 0o400);
  chmodSync(join(s.secrets, 'auth_client_id'), 0o600);
  writeFileSync(join(s.secrets, 'auth_client_id'), 'CHANGE_ME');
  chmodSync(join(s.secrets, 'auth_client_id'), 0o400);
  unlinkSync(join(s.secrets, 'microsoft_web_client_id'));
  symlinkSync(join(s.secrets, 'auth_client_secret'), join(s.secrets, 'microsoft_web_client_id'));
  const r = await s.run();
  assert.ok(has(r.errors, /mistral_api_key : mode 0400 attendu/));
  assert.ok(has(r.errors, /google_web_client_secret absent/));
  assert.ok(has(r.errors, /relay_secret_key : 32 octets/));
  assert.ok(has(r.errors, /auth_client_id : valeur de modèle/));
  assert.ok(has(r.errors, /microsoft_web_client_id : fichier ordinaire attendu/));
  assert.ok(!has(r.notes, /validation du runtime/), 'pas de validation runtime tant que des erreurs subsistent');
});

test('répertoires : existants, droits stricts, disjoints, hors dépôt ; clé du coffre jamais dans les données', { skip }, async t => {
  const s = await setup(t);
  chmodSync(s.data, 0o755);
  writeFileSync(join(s.data, 'secret.key'), 'x');
  rmSync(join(s.root, 'h', 'backups', 'status'), { recursive: true });
  const r = await s.run();
  assert.ok(has(r.errors, /RELAY_DATA_DIR accessible au groupe/));
  assert.ok(has(r.errors, /RELAY_DATA_DIR contient secret\.key/));
  assert.ok(has(r.errors, /RELAY_BACKUP_DIR\/status n’existe pas/));
  const nested = await setup(t);
  const inner = join(nested.data, 'backups');
  mkdirSync(inner, { mode: 0o700 });
  for (const d of ['archives', 'status']) mkdirSync(join(inner, d), { mode: 0o700 });
  writeFileSync(nested.envFile, readFileSync(nested.envFile, 'utf8').replace(/^RELAY_BACKUP_DIR=.*$/m, `RELAY_BACKUP_DIR=${inner}`));
  assert.ok(has((await nested.run()).errors, /RELAY_DATA_DIR et RELAY_BACKUP_DIR doivent être disjoints/));
  const missing = await setup(t, { RELAY_DATA_DIR: join(tmpdir(), 'relay-inexistant-' + process.pid) });
  assert.ok(has((await missing.run()).errors, /RELAY_DATA_DIR n’existe pas \(il n’est jamais créé implicitement\)/));
  const repo = await setup(t, { RELAY_SECRETS_DIR: new URL('../deploy', import.meta.url).pathname });
  assert.ok(has((await repo.run()).errors, /RELAY_SECRETS_DIR ne doit pas être dans le dépôt/));
});

test('clé de sauvegarde : distincte du coffre, hors secrets de l’application, données et archives', { skip }, async t => {
  const same = await setup(t);
  chmodSync(same.backupKey, 0o600);
  writeFileSync(same.backupKey, readFileSync(join(same.secrets, 'relay_secret_key')));
  chmodSync(same.backupKey, 0o400);
  assert.ok(has((await same.run()).errors, /distincte de la clé du coffre/));
  const inArchives = await setup(t);
  const moved = join(inArchives.root, 'h', 'backups', 'archives', 'backup.key');
  writeFileSync(moved, readFileSync(inArchives.backupKey), { mode: 0o400 });
  writeFileSync(inArchives.envFile, readFileSync(inArchives.envFile, 'utf8').replace(/^RELAY_BACKUP_KEY_FILE=.*$/m, `RELAY_BACKUP_KEY_FILE=${moved}`));
  assert.ok(has((await inArchives.run()).errors, /ne doit pas être dans RELAY_BACKUP_DIR/));
  const inSecrets = await setup(t);
  writeFileSync(join(inSecrets.secrets, 'backup_key'), readFileSync(inSecrets.backupKey), { mode: 0o400 });
  writeFileSync(inSecrets.envFile, readFileSync(inSecrets.envFile, 'utf8').replace(/^RELAY_BACKUP_KEY_FILE=.*$/m, `RELAY_BACKUP_KEY_FILE=${join(inSecrets.secrets, 'backup_key')}`));
  const r = await inSecrets.run();
  assert.ok(has(r.errors, /ne doit pas être dans RELAY_SECRETS_DIR/));
  assert.ok(has(r.warnings, /fichiers non utilisés/));
});

test('service de sauvegarde : tmpfs du snapshot assez grand pour la base, mémoire au-dessus du tmpfs', { skip }, async t => {
  const small = await setup(t, { RELAY_BACKUP_TMPFS_SIZE: '64m', RELAY_BACKUP_MEM_LIMIT: '256m' });
  writeFileSync(join(small.data, 'relay.db'), Buffer.alloc(8 * 1024 * 1024));
  const r = await small.run();
  assert.ok(has(r.errors, /RELAY_BACKUP_MEM_LIMIT doit dépasser RELAY_BACKUP_TMPFS_SIZE/));
  assert.ok(has(r.errors, /RELAY_BACKUP_TMPFS_SIZE trop petit pour la base actuelle \(8 Mio\) : au moins 74 Mio/));
  const fine = await setup(t, { RELAY_BACKUP_TMPFS_SIZE: '1g', RELAY_BACKUP_MEM_LIMIT: '1536m' });
  writeFileSync(join(fine.data, 'relay.db'), Buffer.alloc(8 * 1024 * 1024));
  assert.ok(has((await fine.run()).notes, /tmpfs de sauvegarde suffisant/));
  const bad = await setup(t, { RELAY_BACKUP_TMPFS_SIZE: 'beaucoup' });
  assert.ok(has((await bad.run()).errors, /RELAY_BACKUP_TMPFS_SIZE invalide/));
  const { parseSize } = await load();
  assert.deepEqual([parseSize('1g'), parseSize('1536m'), parseSize('512k'), parseSize('100'), parseSize('1.5g'), parseSize('x')], [1073741824, 1610612736, 524288, 100, 1610612736, null]);
});

test('fichier d’environnement : chemin absolu, hors dépôt, non lisible par d’autres', { skip }, async t => {
  const { preflight } = await load();
  assert.ok(has((await preflight({ envFile: 'hosted.env', uid })).errors, /chemin absolu/));
  const s = await setup(t);
  chmodSync(s.envFile, 0o644);
  assert.ok(has((await s.run()).errors, /fichier d’environnement accessible/));
});

test('ligne de commande : code 1 et aucun secret affiché en cas de refus ; code 0 sur configuration fictive valide', { skip }, async t => {
  const s = await setup(t, { AUTH_CLIENT_SECRET: 'fictif-ne-pas-afficher' });
  const script = new URL('../deploy/preflight.mjs', import.meta.url).pathname;
  const bad = spawnSync(process.execPath, [script, '--env-file', s.envFile, '--fictif', '--uid', String(uid)], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Préflight refusé/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /fictif-ne-pas-afficher/);
  for (const file of ['relay_secret_key', 'auth_client_secret']) assert.ok(!(bad.stdout + bad.stderr).includes(readFileSync(join(s.secrets, file), 'utf8').trim()));
  const ok = await setup(t);
  const good = spawnSync(process.execPath, [script, '--env-file', ok.envFile, '--fictif', '--uid', String(uid)], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /FICTIVE : non déployable/);
});
