import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const files = readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const latest=Math.max(0,...files.map(file=>Number(file.split('_')[0])));
  if(current>latest)throw new Error('Schéma de données plus récent que cette version : restauration compatible requise pour un retour arrière.');
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (version <= current) continue;
    transaction(db, () => {
      db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
