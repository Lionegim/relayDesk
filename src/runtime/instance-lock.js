import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Verrou de processus porté par le noyau via une base SQLite distincte en mode rollback.
// Ni PID périssable, ni délai de bail : un crash libère le verrou, jamais supprimer/remplacer le fichier en cours d'usage.
export function acquireInstanceLock(dataDir) {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  let db;
  try {
    db=new DatabaseSync(join(dataDir,'.relay-instance.sqlite'));
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS instance_guard (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
  } catch {
    try {db?.close();} catch {}
    const error=new Error('Le répertoire de données est déjà utilisé ou son verrou est inaccessible.');error.code='instance_locked';throw error;
  }
  let released=false;
  return ()=>{if(!released){released=true;try {db.exec('ROLLBACK');}finally{db.close();}}};
}
