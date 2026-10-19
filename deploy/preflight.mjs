// Préflight de déploiement hébergé : contrôle STRICT et HORS LIGNE de la configuration côté hôte, avant tout démarrage.
// N'ouvre aucun port, ne démarre aucun conteneur, ne contacte ni DNS, ni ACME, ni Keycloak, ni fournisseur.
// N'affiche jamais une valeur secrète : seulement des noms de fichiers et des constats.
//
//   node deploy/preflight.mjs --env-file /etc/relay-desk/hosted.env [--compose] [--fictif] [--uid 1000]
//
// --compose : fait aussi analyser compose.yaml par « docker compose config » (client seul, rien n'est lancé).
// --fictif  : accepte les domaines réservés aux tests (example.test, .invalid…) pour une répétition sur valeurs fictives ;
//             le résultat est alors marqué « non déployable ».
// Code de sortie 0 seulement sans aucune erreur.
import { readFileSync, lstatSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Fichiers attendus dans RELAY_SECRETS_DIR (mêmes noms que la section « secrets » de compose.yaml) et variable *_FILE lue par le runtime.
export const SECRET_FILES = Object.freeze({
  auth_client_id: 'AUTH_CLIENT_ID',
  auth_client_secret: 'AUTH_CLIENT_SECRET',
  relay_secret_key: 'RELAY_SECRET_KEY',
  mistral_api_key: 'MISTRAL_API_KEY',
  google_web_client_id: 'GOOGLE_WEB_CLIENT_ID',
  google_web_client_secret: 'GOOGLE_WEB_CLIENT_SECRET',
  microsoft_web_client_id: 'MICROSOFT_WEB_CLIENT_ID',
  microsoft_web_client_secret: 'MICROSOFT_WEB_CLIENT_SECRET',
});
export const REQUIRED_VARS = ['RELAY_IMAGE_TAG', 'PUBLIC_BASE_URL', 'RELAY_DOMAIN', 'ACME_EMAIL', 'RELAY_SECRETS_DIR', 'RELAY_DATA_DIR', 'RELAY_BACKUP_DIR', 'RELAY_BACKUP_KEY_FILE', 'AUTH_ISSUER', 'AUTH_OWNER_SUB', 'AUTH_MFA_ACR'];
export const OPTIONAL_VARS = ['MICROSOFT_TENANT', 'ACME_CA', 'COMPOSE_PROJECT_NAME', 'RELAY_BACKUP_TMPFS_SIZE', 'RELAY_BACKUP_MEM_LIMIT'];
// Sous-répertoires de RELAY_BACKUP_DIR : archives chiffrées, état lu par l'application. Aucun snapshot en clair ici.
export const BACKUP_SUBDIRS = ['archives', 'status'];
// Valeurs par défaut de compose.yaml pour le service « backup ».
export const BACKUP_DEFAULTS = Object.freeze({ tmpfs: '1g', mem: '1536m' });
const MIB = 1024 * 1024;
// Tailles au format Docker : nombre suivi éventuellement de b, k, m ou g (puissances de 1024).
export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(String(text || '').trim());
  if (!m) return null;
  return Math.floor(Number(m[1]) * { '': 1, b: 1, k: 1024, m: MIB, g: 1024 * MIB }[m[2].toLowerCase()]);
}
const ACME_CAS = {
  'https://acme-v02.api.letsencrypt.org/directory': 'production',
  'https://acme-staging-v02.api.letsencrypt.org/directory': 'test (staging)',
};
// Toute valeur secrète doit être un fichier : ces noms sont interdits dans le fichier d'environnement.
const SECRET_LIKE = /(SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE|_KEY$)/;
// Valeur de modèle : marqueur explicite n'importe où, ou valeur entière générique. Jamais une simple suite de
// caractères qu'une clé aléatoire pourrait contenir (base64 : « xXx », « ToDo »…).
const isPlaceholder = v => /A_RENSEIGNER|À_RENSEIGNER|CHANGE_?ME|<[^<>]+>/.test(v) || /^(todo|xxx+|changeme|secret|password)$/i.test(v.trim());
const RESERVED_TLD = /\.(test|example|invalid|localhost|local)$|(^|\.)example\.(com|net|org)$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// Format d'un fichier d'environnement Compose : CLE=valeur, commentaires #, guillemets simples ou doubles autour de la valeur.
export function parseEnvFile(text) {
  const vars = {}, problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) { problems.push(`ligne ${i + 1} illisible`); return; }
    let value = m[2];
    const q = /^(['"])(.*)\1$/.exec(value);
    if (q) value = q[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    if (Object.hasOwn(vars, m[1])) problems.push(`${m[1]} défini plusieurs fois`);
    vars[m[1]] = value;
  });
  return { vars, problems };
}

const modeOf = st => st.mode & 0o777;
const octal = n => n.toString(8).padStart(4, '0');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };

function vaultKeyValid(text) {
  if (/^[0-9a-f]{64}$/i.test(text)) return true;
  const raw = Buffer.from(text, 'base64');
  return raw.length === 32 && raw.toString('base64') === text;
}

/**
 * Contrôle la configuration. Ne lève pas : renvoie { errors, warnings, notes, fictif }.
 * uid : propriétaire attendu des secrets et des données (1000 dans l'image).
 */
export async function preflight({ envFile, uid = 1000, fictif = false, compose = false, projectDir = PROJECT_DIR } = {}) {
  const errors = [], warnings = [], notes = [];
  const err = m => errors.push(m), warn = m => warnings.push(m), note = m => notes.push(m);
  if (!envFile || !isAbsolute(envFile)) { err('--env-file doit être un chemin absolu, hors du dépôt.'); return { errors, warnings, notes, fictif }; }
  let envStat;
  try { envStat = lstatSync(envFile); } catch { err('fichier d’environnement introuvable.'); return { errors, warnings, notes, fictif }; }
  if (!envStat.isFile() || envStat.isSymbolicLink()) err('le fichier d’environnement doit être un fichier ordinaire (pas un lien).');
  if (inside(real(projectDir), real(envFile))) err('le fichier d’environnement ne doit pas être dans le dépôt.');
  if (modeOf(envStat) & 0o077) err(`fichier d’environnement accessible au groupe ou aux autres (mode ${octal(modeOf(envStat))}, attendu 0600 ou 0400).`);
  const { vars, problems } = parseEnvFile(readFileSync(envFile, 'utf8'));
  problems.forEach(p => err(`fichier d’environnement : ${p}.`));

  // Variables : aucune valeur secrète, aucune variable inconnue, aucune valeur de modèle.
  for (const name of Object.keys(vars)) {
    const known = REQUIRED_VARS.includes(name) || OPTIONAL_VARS.includes(name);
    if (!known && SECRET_LIKE.test(name)) err(`${name} : les secrets se fournissent en fichiers dans RELAY_SECRETS_DIR, jamais dans le fichier d’environnement.`);
    else if (!known) warn(`${name} : variable inconnue, ignorée par compose.yaml.`);
    if (isPlaceholder(vars[name])) err(`${name} : valeur de modèle à remplacer.`);
  }
  for (const name of REQUIRED_VARS) if (!vars[name]) err(`${name} est requis.`);

  // Domaine, origine publique et ACME.
  const domain = vars.RELAY_DOMAIN || '';
  if (domain) {
    if (isIP(domain) || !DOMAIN.test(domain)) err('RELAY_DOMAIN doit être un nom de domaine complet (pas une adresse IP).');
    if (RESERVED_TLD.test(domain)) (fictif ? note : err)(`RELAY_DOMAIN utilise un domaine réservé aux tests${fictif ? ' : configuration fictive, non déployable' : ''}.`);
  }
  // Une répétition fictive ne doit jamais porter un vrai domaine.
  if (fictif && domain && !RESERVED_TLD.test(domain)) err('--fictif exige un domaine réservé aux tests (p. ex. relay.example.test).');
  if (vars.PUBLIC_BASE_URL && domain && vars.PUBLIC_BASE_URL !== `https://${domain}`) err('PUBLIC_BASE_URL doit valoir exactement https://RELAY_DOMAIN (sans port, chemin ni barre finale).');
  if (vars.ACME_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vars.ACME_EMAIL)) err('ACME_EMAIL invalide.');
  const ca = vars.ACME_CA || 'https://acme-v02.api.letsencrypt.org/directory';
  if (ACME_CAS[ca]) note(`autorité ACME : Let's Encrypt ${ACME_CAS[ca]}.`);
  else if (!/^https:\/\//.test(ca)) err('ACME_CA doit être une URL HTTPS.');
  else warn('ACME_CA : autorité autre que Let’s Encrypt, à confirmer.');

  // Image : étiquette immuable (empreinte de commit ou version), jamais « latest ».
  const tag = vars.RELAY_IMAGE_TAG || '';
  if (tag && !/^([0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/.test(tag)) err('RELAY_IMAGE_TAG doit être une empreinte de commit ou une version vX.Y.Z (jamais latest).');
  const head = spawnSync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (tag && /^[0-9a-f]{7,40}$/.test(tag) && head.status === 0 && !head.stdout.trim().startsWith(tag)) warn('RELAY_IMAGE_TAG ne correspond pas au commit du dépôt présent : l’image construite ne serait pas celle annoncée.');
  const dirty = spawnSync('git', ['-C', projectDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (dirty.status === 0 && dirty.stdout.trim()) warn('le dépôt contient des modifications non validées : construire depuis un commit propre.');

  // Identité du propriétaire (Keycloak) : valeurs explicites, vérifiées plus tard sur un vrai jeton.
  if (vars.AUTH_ISSUER) {
    let issuer = null;
    try { issuer = new URL(vars.AUTH_ISSUER); } catch { err('AUTH_ISSUER invalide.'); }
    if (issuer) {
      if (issuer.hostname === domain) err('AUTH_ISSUER doit être servi par un autre hôte que Relay Desk (Caddy envoie tout le domaine à l’application).');
      if (!/^\/realms\/[^/]+$/.test(issuer.pathname)) warn('AUTH_ISSUER ne suit pas la forme Keycloak https://hôte/realms/<realm>.');
      if (RESERVED_TLD.test(issuer.hostname)) (fictif ? note : err)('AUTH_ISSUER utilise un domaine réservé aux tests.');
    }
  }
  if (vars.AUTH_OWNER_SUB && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vars.AUTH_OWNER_SUB)) warn('AUTH_OWNER_SUB n’a pas la forme d’un identifiant Keycloak (UUID) : vérifier qu’il ne s’agit pas d’un nom ou d’une adresse.');
  if (['0', '1'].includes(vars.AUTH_MFA_ACR)) warn('AUTH_MFA_ACR vaut une valeur acr par défaut de Keycloak : utiliser la valeur associée au niveau MFA (p. ex. relay-mfa).');

  // Répertoires : absolus, hors dépôt, disjoints, droits stricts.
  const secretsDir = vars.RELAY_SECRETS_DIR, dataDir = vars.RELAY_DATA_DIR, backupDir = vars.RELAY_BACKUP_DIR;
  const dirs = [['RELAY_SECRETS_DIR', secretsDir], ['RELAY_DATA_DIR', dataDir], ['RELAY_BACKUP_DIR', backupDir]].filter(([, d]) => d);
  for (const [name, dir] of dirs) {
    if (!isAbsolute(dir)) { err(`${name} doit être un chemin absolu.`); continue; }
    let st;
    try { st = lstatSync(dir); } catch { err(`${name} n’existe pas (il n’est jamais créé implicitement).`); continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) { err(`${name} doit être un répertoire (pas un lien).`); continue; }
    if (inside(real(projectDir), real(dir))) err(`${name} ne doit pas être dans le dépôt.`);
    if (modeOf(st) & 0o077) err(`${name} accessible au groupe ou aux autres (mode ${octal(modeOf(st))}, attendu 0700 ou 0500).`);
    if (name !== 'RELAY_SECRETS_DIR' && st.uid !== uid) err(`${name} doit appartenir à l’uid ${uid} (utilisateur de l’image).`);
  }
  const absDirs = dirs.filter(([, d]) => isAbsolute(d));
  for (let i = 0; i < absDirs.length; i++) for (let j = i + 1; j < absDirs.length; j++) {
    const [a, da] = absDirs[i], [b, db] = absDirs[j];
    if (inside(real(da), real(db)) || inside(real(db), real(da))) err(`${a} et ${b} doivent être disjoints.`);
  }
  if (backupDir && isAbsolute(backupDir) && existsSync(backupDir)) {
    for (const sub of BACKUP_SUBDIRS) {
      let st;
      try { st = lstatSync(join(backupDir, sub)); } catch { err(`RELAY_BACKUP_DIR/${sub} n’existe pas.`); continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) err(`RELAY_BACKUP_DIR/${sub} doit être un répertoire.`);
      else if (st.uid !== uid || (modeOf(st) & 0o077)) err(`RELAY_BACKUP_DIR/${sub} : uid ${uid} et mode 0700 attendus.`);
    }
  }
  if (dataDir && isAbsolute(dataDir) && existsSync(dataDir)) {
    try {
      const entries = readdirSync(dataDir);
      if (entries.includes('secret.key')) err('RELAY_DATA_DIR contient secret.key : la clé du coffre doit rester hors des données.');
      note(entries.includes('relay.db') ? 'RELAY_DATA_DIR contient une base existante : la clé du coffre doit être la sienne.' : 'RELAY_DATA_DIR ne contient pas de base : instance vide.');
    } catch { err('RELAY_DATA_DIR illisible pour ce contrôle.'); }
  }

  // Service de sauvegarde : le tmpfs /tmp reçoit le snapshot en clair de toute la base ; il compte dans la mémoire du conteneur.
  const tmpfs = parseSize(vars.RELAY_BACKUP_TMPFS_SIZE || BACKUP_DEFAULTS.tmpfs), mem = parseSize(vars.RELAY_BACKUP_MEM_LIMIT || BACKUP_DEFAULTS.mem);
  if (!tmpfs) err('RELAY_BACKUP_TMPFS_SIZE invalide (p. ex. 1g ou 1536m).');
  if (!mem) err('RELAY_BACKUP_MEM_LIMIT invalide (p. ex. 1536m ou 2g).');
  if (tmpfs && mem && mem < tmpfs + 256 * MIB) err('RELAY_BACKUP_MEM_LIMIT doit dépasser RELAY_BACKUP_TMPFS_SIZE d’au moins 256 Mio (le tmpfs compte dans la mémoire du conteneur).');
  if (tmpfs && dataDir && isAbsolute(dataDir) && existsSync(join(dataDir, 'relay.db'))) {
    let size = 0;
    for (const f of ['relay.db', 'relay.db-wal']) { try { size += lstatSync(join(dataDir, f)).size; } catch { /* absent */ } }
    const needed = Math.ceil(size * 1.25) + 64 * MIB;
    if (tmpfs < needed) err(`RELAY_BACKUP_TMPFS_SIZE trop petit pour la base actuelle (${Math.ceil(size / MIB)} Mio) : au moins ${Math.ceil(needed / MIB)} Mio.`);
    else note(`tmpfs de sauvegarde suffisant pour la base actuelle (${Math.ceil(size / MIB)} Mio, marge 25 % + 64 Mio).`);
  }

  // Secrets : un fichier par valeur, propriétaire uid, mode 0400, non vide, sans valeur de modèle.
  const values = {};
  if (secretsDir && isAbsolute(secretsDir) && existsSync(secretsDir)) {
    for (const file of Object.keys(SECRET_FILES)) {
      const path = join(secretsDir, file);
      let st;
      try { st = lstatSync(path); } catch { err(`secret ${file} absent.`); continue; }
      if (!st.isFile() || st.isSymbolicLink()) { err(`secret ${file} : fichier ordinaire attendu (pas un lien).`); continue; }
      if (st.uid !== uid) err(`secret ${file} : propriétaire uid ${uid} attendu.`);
      if (modeOf(st) !== 0o400) err(`secret ${file} : mode 0400 attendu (actuel ${octal(modeOf(st))}).`);
      if (st.size === 0 || st.size > 65536) { err(`secret ${file} : vide ou trop volumineux.`); continue; }
      let text;
      try { text = readFileSync(path, 'utf8').trim(); } catch { err(`secret ${file} illisible pour ce contrôle.`); continue; }
      if (!text) { err(`secret ${file} vide.`); continue; }
      if (isPlaceholder(text)) err(`secret ${file} : valeur de modèle à remplacer.`);
      values[file] = text;
    }
    if (values.relay_secret_key && !vaultKeyValid(values.relay_secret_key)) err('secret relay_secret_key : 32 octets en base64 canonique ou 64 caractères hexadécimaux attendus.');
    const extra = readdirSync(secretsDir).filter(f => !Object.hasOwn(SECRET_FILES, f));
    if (extra.length) warn(`RELAY_SECRETS_DIR contient des fichiers non utilisés (${extra.length}) : les retirer, en particulier toute clé de sauvegarde.`);
  }

  // Clé de sauvegarde : montée seulement dans le service « backup » ; jamais avec les secrets de l'application,
  // les données, les archives ou le dépôt ; distincte de la clé du coffre.
  if (vars.RELAY_BACKUP_KEY_FILE) {
    const path = vars.RELAY_BACKUP_KEY_FILE;
    if (!isAbsolute(path)) err('RELAY_BACKUP_KEY_FILE doit être un chemin absolu.');
    else {
      for (const [name, dir] of [['RELAY_SECRETS_DIR (monté dans l’application)', secretsDir], ['RELAY_DATA_DIR', dataDir], ['RELAY_BACKUP_DIR (copié hors de la VM)', backupDir]]) {
        if (dir && isAbsolute(dir) && inside(real(dir), real(path))) err(`la clé de sauvegarde ne doit pas être dans ${name}.`);
      }
      if (inside(real(projectDir), real(path))) err('la clé de sauvegarde ne doit pas être dans le dépôt.');
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink()) err('RELAY_BACKUP_KEY_FILE : fichier ordinaire attendu.');
        if (st.uid !== uid) err(`RELAY_BACKUP_KEY_FILE : propriétaire uid ${uid} attendu (lue par le service de sauvegarde).`);
        if (modeOf(st) !== 0o400) err(`RELAY_BACKUP_KEY_FILE : mode 0400 attendu (actuel ${octal(modeOf(st))}).`);
        const text = readFileSync(path, 'utf8').trim();
        if (!text) err('RELAY_BACKUP_KEY_FILE vide.');
        else {
          if (values.relay_secret_key && text === values.relay_secret_key) err('la clé de sauvegarde doit être distincte de la clé du coffre.');
          if (!vaultKeyValid(text)) warn('RELAY_BACKUP_KEY_FILE : format différent de 32 octets base64/hexadécimal, à confirmer avec l’outil de sauvegarde.');
        }
      } catch { err('RELAY_BACKUP_KEY_FILE absent ou illisible.'); }
    }
  }

  // Même validation que le runtime au démarrage, avec l'environnement que compose.yaml lui fournirait.
  if (!errors.length) {
    const env = {
      RELAY_MODE: 'hosted', AUTH_MODE: 'oidc', HOST: '0.0.0.0', PORT: '4310', DATA_DIR: '/data', MAIL_OAUTH_MODE: 'web', DEMO_DATA: '0',
      PUBLIC_BASE_URL: vars.PUBLIC_BASE_URL, AUTH_ISSUER: vars.AUTH_ISSUER, AUTH_OWNER_SUB: vars.AUTH_OWNER_SUB, AUTH_MFA_ACR: vars.AUTH_MFA_ACR,
      MICROSOFT_TENANT: vars.MICROSOFT_TENANT || 'common',
      ...Object.fromEntries(Object.entries(SECRET_FILES).map(([file, name]) => [`${name}_FILE`, join(secretsDir, file)])),
    };
    try {
      const { readConfig } = await import(pathToFileURL(join(projectDir, 'src/runtime/config.js')).href);
      readConfig(env, { cwd: '/' });
      note('configuration acceptée par la validation du runtime (mode hébergé).');
    } catch (e) {
      err(`validation du runtime : ${String(e?.message || e).replace(/^Configuration : /, '')}`);
    }
  }

  // Analyse de compose.yaml par le client Docker seul (aucun conteneur créé).
  if (compose) {
    const r = spawnSync('docker', ['compose', '--env-file', envFile, '--project-directory', projectDir, '-f', join(projectDir, 'compose.yaml'), '--profile', 'hosted', 'config', '--quiet'], { encoding: 'utf8' });
    if (r.error) warn('docker compose indisponible : analyse de compose.yaml non faite.');
    else if (r.status !== 0) err(`docker compose config a refusé la configuration : ${(r.stderr || '').split('\n').find(Boolean) || 'erreur'}`);
    else note('compose.yaml analysé par docker compose config (rien n’a été démarré).');
  }
  if (existsSync(join(projectDir, '.env'))) warn('un fichier .env existe dans le dépôt : ne jamais lancer Compose sans --env-file explicite.');
  return { errors, warnings, notes, fictif };
}

function cli(argv) {
  const opts = { uid: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env-file') opts.envFile = argv[++i];
    else if (a === '--uid') opts.uid = Number(argv[++i]);
    else if (a === '--fictif') opts.fictif = true;
    else if (a === '--compose') opts.compose = true;
    else { console.error(`Option inconnue : ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(opts.uid) || opts.uid < 0) { console.error('--uid invalide.'); process.exit(2); }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings, notes, fictif } = await preflight(cli(process.argv.slice(2)));
  for (const n of notes) console.log(`OK         ${n}`);
  for (const w of warnings) console.log(`ATTENTION  ${w}`);
  for (const e of errors) console.log(`ERREUR     ${e}`);
  console.log(errors.length
    ? `Préflight refusé : ${errors.length} erreur(s). Rien n'a été démarré.`
    : fictif ? 'Préflight réussi sur configuration FICTIVE : non déployable. Rien n’a été démarré.' : 'Préflight réussi. Rien n’a été démarré ; le déploiement reste une action explicite.');
  process.exit(errors.length ? 1 : 0);
}
