// Archives SQLite authentifiées, sans clé du coffre dans l'archive. Aucun transport réseau ici.
import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,createCipheriv,createDecipheriv,createHash,timingSafeEqual} from 'node:crypto';
import {createReadStream,createWriteStream,appendFileSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,statSync,linkSync,unlinkSync,renameSync,openSync,closeSync,fsyncSync,existsSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {resolve,join,dirname,relative,isAbsolute,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createVault} from '../secrets.js';
import {openDatabase} from '../db/index.js';
import {acquireInstanceLock} from '../runtime/instance-lock.js';

const MAGIC=Buffer.from('RLYBAK01'),HEADER_BYTES=20,TAG_BYTES=16;
export const RESTORE_HOLD='restore-hold.json';
const fail=message=>{throw new Error(message);};
function keys(backupKey,vaultKey) {
  if(!Buffer.isBuffer(backupKey)||backupKey.length!==32||!Buffer.isBuffer(vaultKey)||vaultKey.length!==32) fail('Deux clés distinctes de 32 octets sont requises.');
  if(timingSafeEqual(backupKey,vaultKey)) fail('La clé de sauvegarde doit être distincte de la clé du coffre.');
}
export function readOpsKey(path) {
  const info=statSync(path);
  if(!info.isFile() || info.size>256 || (info.mode & 0o077)) fail('Le fichier de clé doit être privé (mode 0600 ou 0400).');
  const text=readFileSync(path,'utf8').trim(),key=Buffer.from(text,/^[a-f0-9]{64}$/i.test(text)?'hex':'base64');
  if(key.length!==32 || (!/^[a-f0-9]{64}$/i.test(text) && key.toString('base64')!==text)) fail('Clé invalide : 32 octets en base64 ou hexadécimal requis.');
  return key;
}
// Résoudre aussi les parents symboliques pour les chemins de sortie qui n'existent pas encore.
function canonical(path) {
  const target=resolve(path);
  if(existsSync(target)||(()=>{try{return lstatSync(target).isSymbolicLink();}catch{return false;}})())return realpathSync(target);
  const parent=dirname(target);if(parent===target)return target;
  return join(canonical(parent),basename(target));
}
function table(db,name) {return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function verify(db,vaultKey) {
  if(db.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok') || db.prepare('PRAGMA foreign_key_check').all().length) fail('La base de sauvegarde est incohérente.');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  const latest=Math.max(...readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>/^\d+_.*\.sql$/.test(f)).map(f=>Number(f.split('_')[0])));
  if(version<1 || version>latest || !table(db,'messages') || !table(db,'accounts')) fail('Schéma de sauvegarde non pris en charge.');
  const vault=createVault(vaultKey);
  try {for(const name of ['secrets','whatsapp_auth','whatsapp_media'])if(table(db,name))for(const row of db.prepare(`SELECT account_id,iv,tag,ciphertext FROM ${name}`).all())vault.open(row.account_id,row);}
  catch {fail('La clé du coffre ne correspond pas à cette sauvegarde.');}
  return version;
}
function durable(path) {const fd=openSync(path,'r');try {fsyncSync(fd);}finally {closeSync(fd);}}
function atomicJSON(path,value) {
  const temporary=path+'.'+randomBytes(8).toString('hex')+'.partial';
  try {writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});durable(temporary);renameSync(temporary,path);}
  finally {rmSync(temporary,{force:true});}
}
async function checksum(path) {const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}

export async function createBackup({dataDir,archive,backupKey,vaultKey,stagingDir,statusFile,clock=Date.now}) {
  keys(backupKey,vaultKey);
  const source=join(resolve(dataDir),'relay.db'),destination=resolve(archive);
  const within=path=>{const rel=relative(canonical(dataDir),canonical(path));return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};
  if(within(destination)) fail('La sauvegarde doit être écrite hors du répertoire de données.');
  if(statusFile) {
    if(within(statusFile)||canonical(statusFile)===canonical(destination))fail('Le statut doit être distinct des données et de l’archive.');
    if(existsSync(statusFile)) {
      const info=lstatSync(statusFile);if(!info.isFile()||info.size>4096)fail('Fichier de statut invalide.');
      let previous;try {previous=JSON.parse(readFileSync(statusFile,'utf8'));}catch {fail('Fichier de statut invalide.');}
      if(previous.version!==1||!Number.isSafeInteger(previous.createdAt)||!/^[a-f0-9]{64}$/.test(previous.sha256))fail('Fichier de statut invalide.');
    }
  }
  if(existsSync(destination)) fail('Le fichier de sauvegarde existe déjà.');
  // Le snapshot en clair reste dans un espace temporaire privé, jamais parmi les archives.
  // En Docker, /tmp est un tmpfs : même SIGKILL ne laisse pas de snapshot sur le disque de sauvegarde.
  const parent=dirname(destination),temporaryParent=resolve(stagingDir || tmpdir());
  mkdirSync(parent,{recursive:true,mode:0o700});mkdirSync(temporaryParent,{recursive:true,mode:0o700});
  const stagingRelative=relative(canonical(parent),canonical(temporaryParent));
  if(within(parent) || stagingRelative==='' || (!isAbsolute(stagingRelative)&&stagingRelative!=='..'&&!stagingRelative.startsWith('..'+sep)))fail('Le staging temporaire doit être distinct du dossier des archives.');
  const staging=mkdtempSync(join(temporaryParent,'.relay-snapshot-'));
  const encryptedStaging=mkdtempSync(join(parent,'.relay-encrypted-'));
  const snapshot=join(staging,'snapshot.db'),encrypted=join(encryptedStaging,'archive.partial');
  let db;
  try {
    db=new DatabaseSync(source,{readOnly:true});
    await backup(db,snapshot);db.close();db=null;
    const check=new DatabaseSync(snapshot,{readOnly:true});let schemaVersion;
    try {schemaVersion=verify(check,vaultKey);}finally {check.close();}
    const iv=randomBytes(12),header=Buffer.concat([MAGIC,iv]),cipher=createCipheriv('aes-256-gcm',backupKey,iv);
    cipher.setAAD(header);writeFileSync(encrypted,header,{mode:0o600,flag:'wx'});
    await pipeline(createReadStream(snapshot),cipher,createWriteStream(encrypted,{flags:'a'}));
    appendFileSync(encrypted,cipher.getAuthTag());durable(encrypted);
    // Publication atomique sans remplacement ; seuls des octets chiffrés sont sur le système de fichiers des archives.
    linkSync(encrypted,destination);unlinkSync(encrypted);durable(dirname(destination));
    const result={version:1,createdAt:clock(),bytes:statSync(destination).size,schemaVersion,sha256:await checksum(destination),offsiteVerifiedAt:null,restoreTestedAt:null};
    if(statusFile)atomicJSON(resolve(statusFile),result);
    return result;
  } finally {db?.close();rmSync(staging,{recursive:true,force:true});rmSync(encryptedStaging,{recursive:true,force:true});}
}

export async function restoreBackup({archive,dataDir,backupKey,vaultKey,clock=Date.now,maxBytes=16*1024**3}) {
  keys(backupKey,vaultKey);
  const source=resolve(archive),size=statSync(source).size,destination=resolve(dataDir);
  if(size<HEADER_BYTES+TAG_BYTES+512 || size>maxBytes)fail('Taille de sauvegarde invalide.');
  // Une destination neuve uniquement : jamais d'écrasement d'une installation existante, même arrêtée.
  mkdirSync(destination,{mode:0o700});
  let unlock,db;
  try {
    unlock=acquireInstanceLock(destination);
    writeFileSync(join(destination,RESTORE_HOLD),JSON.stringify({version:1,restoredAt:clock(),connectorsHeld:true})+'\n',{flag:'wx',mode:0o600});
    const fd=openSync(source,'r'),header=Buffer.alloc(HEADER_BYTES),tag=Buffer.alloc(TAG_BYTES);
    try {const {readSync}=await import('node:fs');if(readSync(fd,header,0,header.length,0)!==HEADER_BYTES||readSync(fd,tag,0,tag.length,size-TAG_BYTES)!==TAG_BYTES)fail('Archive tronquée.');}finally {closeSync(fd);}
    if(!header.subarray(0,8).equals(MAGIC))fail('Format de sauvegarde non pris en charge.');
    const decipher=createDecipheriv('aes-256-gcm',backupKey,header.subarray(8));decipher.setAAD(header);decipher.setAuthTag(tag);
    const temporary=join(destination,'restore.partial');
    try {await pipeline(createReadStream(source,{start:HEADER_BYTES,end:size-TAG_BYTES-1}),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600}));}
    catch {fail('Sauvegarde non authentifiée : clé incorrecte ou archive altérée.');}
    db=new DatabaseSync(temporary);const sourceSchemaVersion=verify(db,vaultKey);db.close();db=null;
    // Les migrations s'appliquent uniquement à la copie authentifiée, jamais à l'original.
    db=openDatabase(temporary);
    db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    try {
      if(table(db,'auth_sessions'))db.exec('DELETE FROM auth_sessions');
      if(table(db,'whatsapp_auth'))db.exec('DELETE FROM whatsapp_auth');
      db.exec("DELETE FROM secrets WHERE account_id IN (SELECT id FROM accounts WHERE svc='whatsapp'); UPDATE accounts SET status='À reconnecter',c='warn' WHERE svc IN ('gmail','outlook','whatsapp'); UPDATE sync_state SET status='paused',error=NULL;");
      db.exec('COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch(error) {try {db.exec('ROLLBACK');}catch {}throw error;}
    db.close();db=null;durable(temporary);renameSync(temporary,join(destination,'relay.db'));durable(destination);
    return {version:1,restoredAt:clock(),sourceSchemaVersion,connectorsHeld:true,whatsappRelinkRequired:true};
  } catch(error) {db?.close();db=null;unlock?.();unlock=null;rmSync(destination,{recursive:true,force:true});throw error;}
  finally {db?.close();unlock?.();}
}

export function releaseRestoreHold({dataDir,confirm=false}) {
  if(confirm!==true)fail('La reprise exige une confirmation explicite (--confirm-resume).');
  const dir=resolve(dataDir);
  if(!existsSync(join(dir,RESTORE_HOLD)))fail('Aucune restauration suspendue.');
  const unlock=acquireInstanceLock(dir);
  try {if(!existsSync(join(dir,'relay.db')))fail('Base restaurée absente.');unlinkSync(join(dir,RESTORE_HOLD));durable(dir);}
  finally {unlock();}
  return {released:true,whatsappRelinkRequired:true};
}
