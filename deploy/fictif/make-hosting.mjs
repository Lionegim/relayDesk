// Prépare une configuration hébergée ENTIÈREMENT FICTIVE pour répéter le préflight et « docker compose config ».
// Domaines réservés aux tests, identifiants factices, clés aléatoires jetables. Ne démarre rien, ne contacte rien.
//
//   node deploy/fictif/make-hosting.mjs /tmp/relay-fictif
//   node deploy/preflight.mjs --env-file /tmp/relay-fictif/hosted.env --fictif --uid "$(id -u)" [--compose]
//
// Lancé en root, les secrets et les données appartiennent à l'uid 1000 comme sur la VM ; sinon à l'utilisateur courant.
import { mkdirSync, writeFileSync, chownSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';

export function makeFictiveHosting(root, { uid = process.getuid?.() === 0 ? 1000 : process.getuid?.(), tag = '0000000' } = {}) {
  if (!isAbsolute(root)) throw new Error('Chemin absolu requis.');
  if (existsSync(root) && readdirSync(root).length) throw new Error('Le répertoire doit être vide ou absent.');
  const secrets = join(root, 'secrets'), data = join(root, 'data'), backup = join(root, 'backup'), backups = join(root, 'backups');
  const owned = [data, backups, ...['archives', 'status'].map(d => join(backups, d))];
  for (const dir of [root, secrets, backup, ...owned]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fake = {
    auth_client_id: 'relay-desk-fictif',
    auth_client_secret: `fictif-${randomBytes(18).toString('hex')}`,
    relay_secret_key: randomBytes(32).toString('base64'),
    mistral_api_key: `fictif-${randomBytes(16).toString('hex')}`,
    google_web_client_id: 'fictif.apps.example.test',
    google_web_client_secret: `fictif-${randomBytes(16).toString('hex')}`,
    microsoft_web_client_id: randomUUID(),
    microsoft_web_client_secret: `fictif-${randomBytes(16).toString('hex')}`,
  };
  for (const [file, value] of Object.entries(fake)) {
    writeFileSync(join(secrets, file), `${value}\n`, { mode: 0o400 });
    if (process.getuid?.() === 0) chownSync(join(secrets, file), uid, uid);
  }
  // Clé de sauvegarde fictive : distincte du coffre, hors des secrets de l'application et des archives.
  writeFileSync(join(backup, 'backup.key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o400 });
  if (process.getuid?.() === 0) for (const path of [...owned, join(backup, 'backup.key')]) chownSync(path, uid, uid);
  const env = [
    '# Configuration FICTIVE générée pour répétition : non déployable.',
    `RELAY_IMAGE_TAG=${tag}`,
    'RELAY_DOMAIN=relay.example.test',
    'PUBLIC_BASE_URL=https://relay.example.test',
    'ACME_EMAIL=ops@example.test',
    'ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory',
    `RELAY_SECRETS_DIR=${secrets}`,
    `RELAY_DATA_DIR=${data}`,
    `RELAY_BACKUP_DIR=${backups}`,
    `RELAY_BACKUP_KEY_FILE=${join(backup, 'backup.key')}`,
    'AUTH_ISSUER=https://identity.example.test/realms/relay',
    `AUTH_OWNER_SUB=${randomUUID()}`,
    'AUTH_MFA_ACR=relay-mfa',
    'RELAY_CONNECTORS_ENABLED=false',
    'RELAY_AI_ENABLED=false',
    'MICROSOFT_TENANT=consumers',
    '',
  ].join('\n');
  writeFileSync(join(root, 'hosted.env'), env, { mode: 0o600 });
  return { envFile: join(root, 'hosted.env'), secrets, data, backupKey: join(backup, 'backup.key') };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) { console.error('Usage : node deploy/fictif/make-hosting.mjs <répertoire absolu vide>'); process.exit(2); }
  try {
    const out = makeFictiveHosting(root);
    console.log(`Configuration fictive créée (non déployable) : ${out.envFile}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
