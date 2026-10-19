// Chiffrement des jetons au repos (AES-256-GCM). La clé vient de RELAY_SECRET_KEY,
// ou d'un fichier généré une fois dans le dossier de données (droits 0600).
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function decodeKey(value) {
  const raw=String(value).trim();
  const hex=/^[0-9a-f]{64}$/i.test(raw);
  const key=Buffer.from(raw,hex?'hex':'base64');
  if(key.length!==32 || (!hex && key.toString('base64')!==raw)) throw new Error('Clé du coffre invalide : 32 octets encodés en hexadécimal ou base64 requis.');
  return key;
}

export function loadKey({ envKey, keyFile, allowCreate=true }) {
  if (envKey) return decodeKey(envKey);
  if (existsSync(keyFile)) return decodeKey(readFileSync(keyFile,'utf8'));
  if(!allowCreate) throw new Error('Clé du coffre absente : fournir la clé existante avant de reprendre les données.');
  mkdirSync(dirname(keyFile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600, flag:'wx' });
  return key;
}

export function createVault(key) {
  return {
    seal(accountId, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`account:${accountId}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { iv, tag: cipher.getAuthTag(), ciphertext };
    },
    open(accountId, { iv, tag, ciphertext }) {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
      decipher.setAAD(Buffer.from(`account:${accountId}`));
      decipher.setAuthTag(Buffer.from(tag));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString('utf8'));
    },
  };
}
