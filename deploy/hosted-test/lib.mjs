// Outils communs de l'identité de test : secrets neufs, TOTP (RFC 6238), fichiers privés, adresses de boucle locale.
// Aucune dépendance. Aucune valeur secrète n'est jamais écrite sur la sortie standard.
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const randomAlnum = n => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Keycloak conserve le secret OTP tel quel et l'utilise comme clé HMAC (octets UTF-8) ; l'application
// d'authentification reçoit ces mêmes octets en base32.
export function totp(secretValue, { time = Date.now(), period = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / period)));
  const h = createHmac(algorithm, Buffer.from(secretValue, 'utf8')).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

export function otpauthUri({ secretValue, account, issuer, period = 30, digits = 6 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: base32(Buffer.from(secretValue, 'utf8')), issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${q}`;
}

export const isLoopbackUrl = url => {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
};
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };

// Répertoire de sortie privé : absolu, hors dépôt, absent ou vide ; créé en 0700.
export function prepareOutputDir(dir) {
  if (!dir || !isAbsolute(dir)) throw new Error('--out doit être un chemin absolu.');
  if (inside(real(REPO_DIR), real(dir))) throw new Error('--out ne doit pas être dans le dépôt.');
  if (existsSync(dir) && readdirSync(dir).length) throw new Error('--out doit être absent ou vide : aucun secret existant n’est écrasé.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function writePrivate(dir, name, value) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${value}\n`, { mode: 0o400, flag: 'wx' });
  return path;
}
// Lecture d'un fichier secret : présent, non vide, non lisible par les autres.
export function readSecretFile(path, label) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} : chemin absolu requis.`);
  let st;
  try { st = lstatSync(path); } catch { throw new Error(`${label} : fichier absent.`); }
  if (!st.isFile()) throw new Error(`${label} : fichier ordinaire attendu.`);
  if (st.mode & 0o077) throw new Error(`${label} : fichier lisible par le groupe ou les autres.`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${label} : fichier vide.`);
  return value;
}

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Argument inattendu : ${a}`);
    const key = a.slice(2);
    if (!Object.hasOwn(spec, key)) throw new Error(`Option inconnue : ${a}`);
    out[key] = spec[key] === 'flag' ? true : argv[++i];
    if (out[key] === undefined) throw new Error(`Valeur manquante pour ${a}`);
  }
  return out;
}
