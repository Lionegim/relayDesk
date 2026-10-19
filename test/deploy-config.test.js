// Configuration d'hébergement déclarative (compose.yaml, deploy/Caddyfile, modèles systemd et d'environnement).
// Contrôles statiques uniquement : rien n'est démarré, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const skip = existsSync(new URL('../compose.yaml', import.meta.url)) && existsSync(new URL('../deploy/preflight.mjs', import.meta.url)) ? false : 'fichiers de déploiement absents de ce contexte (stage Docker de tests)';
// Bloc d'un service de compose.yaml (indentation de deux espaces).
const service = (yaml, name) => {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, name);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

test('compose.yaml : seul le proxy publie des ports ; services en profils, non-root, lecture seule', { skip }, () => {
  const yaml = read('compose.yaml');
  const relay = service(yaml, 'relay'), backup = service(yaml, 'backup'), proxy = service(yaml, 'proxy');
  assert.doesNotMatch(relay, /\n {4}ports:/);
  assert.doesNotMatch(backup, /\n {4}ports:/);
  assert.match(proxy, /\n {4}ports:/);
  assert.match(relay, /profiles: \["hosted"\]/);
  assert.match(proxy, /profiles: \["hosted"\]/);
  assert.match(backup, /profiles: \["backup"\]/);
  for (const s of [relay, backup]) {
    assert.match(s, /user: "1000:1000"/);
    assert.match(s, /read_only: true/);
    assert.match(s, /cap_drop: \[ALL\]/);
    assert.match(s, /no-new-privileges:true/);
  }
  assert.match(backup, /network_mode: none/);
  // Snapshot en clair uniquement en tmpfs, dimensionné ; mémoire bornée et configurable.
  assert.match(backup, /- \/tmp:size=\$\{RELAY_BACKUP_TMPFS_SIZE:-1g\},mode=1777,noexec,nosuid,nodev/);
  assert.match(backup, /mem_limit: \$\{RELAY_BACKUP_MEM_LIMIT:-1536m\}/);
  assert.doesNotMatch(yaml, /--staging-dir|\/backups\/staging/, 'aucun snapshot en clair dans les sauvegardes');
  assert.match(proxy, /cap_add: \[NET_BIND_SERVICE\]/);
  assert.doesNotMatch(yaml, /env_file:/, 'aucun .env chargé dans les conteneurs');
});

test('compose.yaml : données et sauvegardes en répertoires existants, jamais créés implicitement', { skip }, () => {
  const yaml = read('compose.yaml');
  const relay = service(yaml, 'relay'), backup = service(yaml, 'backup');
  for (const s of [relay, backup]) {
    assert.match(s, /source: \$\{RELAY_DATA_DIR:\?[^}]*\}\n\s+target: \/data\n\s+bind:\n\s+create_host_path: false/);
  }
  assert.match(relay, /source: \$\{RELAY_BACKUP_DIR:\?[^}]*\}\/status\n\s+target: \/backup-status\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/);
  assert.match(relay, /BACKUP_STATUS_FILE: \/backup-status\/last-backup\.json/);
  assert.match(backup, /source: \$\{RELAY_BACKUP_DIR:\?[^}]*\}\n\s+target: \/backups\n\s+bind:\n\s+create_host_path: false/);
  assert.doesNotMatch(relay, /target: \/backups\b/, 'l’application ne voit pas les archives');
  assert.doesNotMatch(yaml, /^\s+relay-data:/m, 'plus de volume nommé implicite pour les données');
});

test('compose.yaml : secrets alignés sur le préflight ; clé de sauvegarde réservée au service de sauvegarde', { skip }, async () => {
  const { SECRET_FILES } = await import('../deploy/preflight.mjs');
  const yaml = read('compose.yaml');
  const relay = service(yaml, 'relay'), backup = service(yaml, 'backup');
  const relaySecrets = [...relay.matchAll(/^ {6}- (\w+)$/gm)].map(m => m[1]).filter(n => Object.hasOwn(SECRET_FILES, n) || n === 'backup_key');
  assert.deepEqual(relaySecrets.sort(), Object.keys(SECRET_FILES).sort());
  for (const [file, name] of Object.entries(SECRET_FILES)) {
    assert.match(yaml, new RegExp(`\\n  ${file}:\\n    file: \\$\\{RELAY_SECRETS_DIR:\\?[^}]*\\}/${file}\\n`), file);
    assert.match(relay, new RegExp(`${name}_FILE: /run/secrets/${file}`), name);
  }
  assert.doesNotMatch(relay, /backup_key/);
  assert.match(backup, /- relay_secret_key\n\s+- backup_key/);
  assert.match(yaml, /\n  backup_key:\n    file: \$\{RELAY_BACKUP_KEY_FILE:\?[^}]*\}/);
  assert.match(backup, /entrypoint: \["node", "--disable-warning=ExperimentalWarning", "scripts\/backup\.mjs"\]/);
});

test('compose.yaml : configuration hébergée imposée, variables obligatoires sans valeur par défaut', { skip }, async () => {
  const { REQUIRED_VARS } = await import('../deploy/preflight.mjs');
  const yaml = read('compose.yaml');
  for (const v of ['RELAY_MODE: hosted', 'AUTH_MODE: oidc', 'MAIL_OAUTH_MODE: web', 'DEMO_DATA: "0"', 'container_name: relay-desk']) assert.ok(yaml.includes(v), v);
  for (const name of REQUIRED_VARS.filter(n => n !== 'RELAY_IMAGE_TAG' || true)) assert.match(yaml, new RegExp(`\\$\\{${name}:\\?`), name);
  assert.doesNotMatch(yaml, /:latest\b/);
});

test('Caddyfile : domaine unique, administration fermée, en-têtes, journaux d’erreurs sans requête', { skip }, () => {
  const caddy = read('deploy/Caddyfile');
  assert.match(caddy, /\n\tadmin off\n/);
  assert.match(caddy, /\n\tacme_ca \{\$ACME_CA\}\n/);
  assert.match(caddy, /\n\{\$RELAY_DOMAIN\} \{\n/);
  assert.match(caddy, /reverse_proxy relay:4310/);
  assert.match(caddy, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  const log = caddy.slice(caddy.indexOf('log default {'), caddy.indexOf('\n}\n'));
  for (const field of ['request', 'uri', 'headers', 'resp_headers']) assert.match(log, new RegExp(`\\n\\t{4}${field} delete\\n`), field);
  // Aucun journal d'accès dans le site : les retours OAuth portent code et state.
  const site = caddy.slice(caddy.indexOf('{$RELAY_DOMAIN} {'));
  assert.doesNotMatch(site, /\n\tlog\b/);
});

test('modèle d’environnement : toutes les variables, aucun secret, valeurs à renseigner refusées par le préflight', { skip }, async () => {
  const { REQUIRED_VARS, parseEnvFile } = await import('../deploy/preflight.mjs');
  const { vars, problems } = parseEnvFile(read('deploy/hosted.env.example'));
  assert.deepEqual(problems, []);
  for (const name of REQUIRED_VARS) assert.ok(Object.hasOwn(vars, name), name);
  for (const name of Object.keys(vars)) assert.doesNotMatch(name, /SECRET$|PASSWORD|TOKEN|API_KEY/);
  assert.ok(Object.values(vars).some(v => v.includes('A_RENSEIGNER')));
});

test('modèles systemd : sauvegarde via le service Compose sans réseau ; copie hors VM conditionnelle, archives seules', { skip }, () => {
  const svc = read('deploy/systemd/relay-desk-backup.service'), timer = read('deploy/systemd/relay-desk-backup.timer'), off = read('deploy/systemd/relay-desk-offsite.service');
  assert.match(svc, /--profile backup run --rm --no-deps backup create --data-dir \/data --archive "\/backups\/archives\/relay-\$\$\{ts\}\.rlybak" --backup-key-file \/run\/secrets\/backup_key --vault-key-file \/run\/secrets\/relay_secret_key --status-file \/backups\/status\/last-backup\.json'$/m);
  assert.doesNotMatch(svc, /staging/);
  assert.match(svc, /date -u \+%%Y%%m%%dT%%H%%M%%SZ/, '% échappé pour systemd');
  assert.match(svc, /--env-file \/etc\/relay-desk\/hosted\.env/);
  assert.match(timer, /Persistent=true/);
  assert.match(off, /ConditionPathExists=\/etc\/relay-desk\/offsite\.env/);
  assert.match(off, /rclone copy --checksum --include "\*\.rlybak" \$\{RELAY_BACKUP_DIR\}\/archives/);
  assert.match(off, /rclone check --one-way --checksum/);
  assert.doesNotMatch(off, /rclone (sync|delete|purge)/);
  assert.doesNotMatch(off, /backup\.key|secrets|relay\.db|\/status/);
});

test('guide d’exploitation : décisions à confirmer, limites non validées, aucune fausse validation', { skip }, () => {
  const doc = read('docs/operations.md');
  for (const needle of ['## Décisions à confirmer', 'Keycloak', 'create_host_path: false', 'Retour arrière', 'uniquement vers l\'avant', 'Non validé', 'non vérifié']) assert.ok(doc.includes(needle), needle);
  assert.doesNotMatch(doc, /\[commande à compléter\]/, 'commandes de sauvegarde renseignées');
});
