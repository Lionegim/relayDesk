import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync,statSync,existsSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createVault} from '../src/secrets.js';
import {createBackup,restoreBackup,releaseRestoreHold,RESTORE_HOLD,readOpsKey} from '../src/ops/backup.js';
import {createRuntime} from '../src/runtime/lifecycle.js';
import {readConfig} from '../src/runtime/config.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'relay-ops-')),dataDir=join(dir,'data');mkdirSync(dataDir);
  const db=openDatabase(join(dataDir,'relay.db'));seedIfEmpty(db);const store=createStore(db),backupKey=randomBytes(32),vaultKey=randomBytes(32),vault=createVault(vaultKey);
  const a=store.upsertAccount('perso',{name:'Compte fictif',channel:'whatsapp',svc:'whatsapp',address:'+33000000000'});
  const id=store.upsertThread(a.id,{...store.getMessage(1),externalId:'33000000001@s.whatsapp.net',from:'Contact fictif',body:'Message confidentiel fictif',trail:[],count:1});
  store.saveDraft(id,'Brouillon fictif');store.rememberReply(id,'Salut exemple de style fictif !');
  store.waAuthSet(a.id,'creds','',vault.seal(a.id,{t:'creds',i:'',v:'fake-whatsapp'}));
  const mail=store.upsertAccount('perso',{name:'Gmail fictif',channel:'email',svc:'gmail',address:'owner@example.test'});store.putSecret(mail.id,vault.seal(mail.id,{refreshToken:'fake-refresh-token'}));
  db.exec('CREATE TABLE auth_sessions(id TEXT); INSERT INTO auth_sessions VALUES (\'old-session\')');
  const archive=join(dir,'archive.rlybak'),statusFile=join(dir,'last-backup.json');let closed=false;
  t.after(()=>{if(!closed)db.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,dataDir,db,store,backupKey,vaultKey,vault,id,account:a.id,mail:mail.id,archive,statusFile,opts:{dataDir,archive,backupKey,vaultKey,statusFile},close(){db.close();closed=true;}};
}

test('snapshot online WAL : archive chiffrée cohérente, sauvegarde distincte, source inchangée',async t=>{
  const f=fixture(t),waCiphertext=f.store.waAuthGet(f.account,'creds','').ciphertext,identity=f.store.getReplyMemory(f.id,{internal:true}).identity;
  // La connexion reste ouverte et le WAL contient les dernières écritures.
  f.store.saveDraft(f.id,'Dernier texte dans WAL');const version=f.store.getMessage(f.id).draftVersion;
  const result=await createBackup(f.opts);assert.equal(result.schemaVersion,f.db.prepare('PRAGMA user_version').get().user_version);assert.equal(statSync(f.archive).mode&0o777,0o600);
  const encrypted=readFileSync(f.archive);assert.equal(encrypted.subarray(0,8).toString(),'RLYBAK01');assert.equal(encrypted.includes(Buffer.from('Message confidentiel fictif')),false);assert.equal(encrypted.includes(f.vaultKey),false);
  assert.equal(JSON.parse(readFileSync(f.statusFile)).sha256,result.sha256);
  const destination=join(f.dir,'restored');await restoreBackup({...f.opts,dataDir:destination});
  const db=new DatabaseSync(join(destination,'relay.db'));try {
    const s=createStore(db);assert.equal(s.getMessage(f.id).draft.text,'Dernier texte dans WAL');assert.equal(s.getMessage(f.id).draftVersion,version);assert.equal(s.getReplyMemory(f.id,{internal:true}).identity,identity);
    assert.equal(f.vault.open(f.mail,s.getSecret(f.mail)).refreshToken,'fake-refresh-token');assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM whatsapp_auth').get().n,0);
    assert.equal(s.getAccount(f.account).status,'À reconnecter');assert.equal(existsSync(join(destination,RESTORE_HOLD)),true);
  }finally {db.close();}
  assert.equal(readFileSync(join(destination,'relay.db')).includes(Buffer.from(waCiphertext)),false,'anciennes sessions absentes des pages SQLite');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM whatsapp_auth').get().n,1);
  await assert.rejects(createBackup(f.opts),/existe/);await assert.rejects(restoreBackup({...f.opts,dataDir:destination}),/exist/i);
  assert.deepEqual(readdirSync(f.dir).filter(x=>x.startsWith('.relay-backup-')),[]);
});

test('restauration : clé archive ou coffre incorrecte, altération et troncature refusées sans résidu',async t=>{
  const f=fixture(t);await createBackup(f.opts);
  for(const [name,changes] of [['archive-key',{backupKey:randomBytes(32)}],['vault-key',{vaultKey:randomBytes(32)}]]) {
    const destination=join(f.dir,name);await assert.rejects(restoreBackup({...f.opts,dataDir:destination,...changes}),/authentifiée|coffre/);assert.equal(existsSync(destination),false);
  }
  const bytes=readFileSync(f.archive);bytes[35]^=1;writeFileSync(join(f.dir,'tampered'),bytes);
  await assert.rejects(restoreBackup({...f.opts,archive:join(f.dir,'tampered'),dataDir:join(f.dir,'bad')}),/authentifiée/);assert.equal(existsSync(join(f.dir,'bad')),false);
  writeFileSync(join(f.dir,'short'),bytes.subarray(0,30));await assert.rejects(restoreBackup({...f.opts,archive:join(f.dir,'short'),dataDir:join(f.dir,'short-data')}),/Taille/);
  await assert.rejects(createBackup({...f.opts,backupKey:f.vaultKey}),/distincte/);
  await assert.rejects(createBackup({...f.opts,archive:join(f.dataDir,'..private','archive')}),/hors/);
  await assert.rejects(createBackup({...f.opts,statusFile:join(f.dataDir,'relay.db')}),/statut/);
});

test('schéma futur refusé : retour arrière ne migre jamais silencieusement une base plus récente',async t=>{
  const f=fixture(t);f.db.exec('PRAGMA user_version=999');await assert.rejects(createBackup(f.opts),/Schéma/);assert.equal(existsSync(f.archive),false);
});

test('restauration : connecteurs et IA restent arrêtés même avec environnement actif ; reprise explicite à froid',async t=>{
  const f=fixture(t);await createBackup(f.opts);const restored=join(f.dir,'restored');await restoreBackup({...f.opts,dataDir:restored});
  const config=readConfig({DATA_DIR:restored,PORT:'0',DEMO_DATA:'0',RELAY_SECRET_KEY:f.vaultKey.toString('base64'),RELAY_CONNECTORS_ENABLED:'true',RELAY_AI_ENABLED:'true',MISTRAL_API_KEY:'fake'});
  const seen=[];
  const rt=createRuntime(config,{providerFactory:async({config})=>{seen.push(config);return{providers:{},gmail:null,syncs:[]};}});await rt.start();
  assert.equal(seen[0].connectorsEnabled,false);assert.equal(seen[0].aiEnabled,false);
  assert.throws(()=>releaseRestoreHold({dataDir:restored,confirm:true}),/verrou|utilisé/);
  await rt.stop();assert.throws(()=>releaseRestoreHold({dataDir:restored}),/confirmation/);releaseRestoreHold({dataDir:restored,confirm:true});
  const rt2=createRuntime(config,{providerFactory:async({config})=>{seen.push(config);return{providers:{},gmail:null,syncs:[]};}});await rt2.start();try {assert.equal(seen[1].connectorsEnabled,true);}finally {await rt2.stop();}
});

test('clé opérations : fichier privé uniquement, contenu et permissions stricts',t=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-key-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'key');const key=randomBytes(32);writeFileSync(file,key.toString('base64'),{mode:0o600});assert.deepEqual(readOpsKey(file),key);writeFileSync(join(dir,'public'),key.toString('base64'),{mode:0o644});assert.throws(()=>readOpsKey(join(dir,'public')),/privé/);
});


test('chemins symboliques : aucune archive dans les données ni snapshot clair parmi les archives',async t=>{
  const f=fixture(t),alias=join(f.dir,'alias');symlinkSync(f.dataDir,alias,'dir');
  await assert.rejects(createBackup({...f.opts,archive:join(alias,'hidden.rlybak')}),/hors/);
  await assert.rejects(createBackup({...f.opts,stagingDir:join(f.dir,'staging')}),/staging/);
  assert.equal(existsSync(f.archive),false);
  const output=join(f.dir,'backups'),outputAlias=join(f.dir,'output-alias');mkdirSync(output);symlinkSync(output,outputAlias,'dir');
  await assert.rejects(createBackup({...f.opts,archive:join(output,'archive'),statusFile:join(outputAlias,'archive')}),/statut/);
  assert.equal(existsSync(join(output,'archive')),false);
});

test('CLI : aucun chemin implicite, refus assainis, sauvegarde/restauration/reprise exactes',async t=>{
  const f=fixture(t),backupFile=join(f.dir,'backup-key'),vaultFile=join(f.dir,'vault-key');
  writeFileSync(backupFile,f.backupKey.toString('base64'),{mode:0o600});writeFileSync(vaultFile,f.vaultKey.toString('base64'),{mode:0o600});
  const run=args=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',new URL('../scripts/backup.mjs',import.meta.url).pathname,...args],{encoding:'utf8',timeout:15000});
  for(const args of [[],['create'],['resume','--data-dir',f.dataDir],['status','--data-dir',f.dataDir,'--unknown','fake-secret'],['status','--data-dir',f.dataDir,'--data-dir',f.dataDir]]){
    const r=run(args);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.doesNotMatch(r.stderr,/fake-secret|fake-refresh-token|Compte fictif/);assert.equal(JSON.parse(r.stderr).error,'operation_failed');
  }
  const common=['--archive',f.archive,'--backup-key-file',backupFile,'--vault-key-file',vaultFile];
  const result=run(['create','--data-dir',f.dataDir,...common]);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).version,1);
  const restored=join(f.dir,'cli-restored');assert.equal(run(['restore','--data-dir',restored,...common]).status,0);
  assert.equal(run(['resume','--data-dir',restored]).status,1);assert.equal(run(['resume','--data-dir',restored,'--confirm-resume']).status,0);
});
