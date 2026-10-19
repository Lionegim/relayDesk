import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {operationsHealth,databaseReady} from '../src/ops/health.js';
import {createApp} from '../src/http/app.js';
import {HttpError} from '../src/http/errors.js';
import {RESTORE_HOLD} from '../src/ops/backup.js';
import {readConfig} from '../src/runtime/config.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'relay-health-')),db=openDatabase(join(dir,'relay.db'));seedIfEmpty(db);const store=createStore(db);let closed=false;
  t.after(()=>{if(!closed)db.close();rmSync(dir,{recursive:true,force:true});});
  const now=Date.now(),disk=()=>({bavail:1000,bsize:1024**2,blocks:2000});
  return {dir,db,store,now,disk,health:extra=>operationsHealth({db,dataDir:dir,clock:()=>now,disk,...extra}),close(){db.close();closed=true;}};
}
test('santé : processus/DB distincts de disque, sauvegarde et connecteur dégradés',t=>{
  const f=fixture(t);assert.equal(databaseReady(f.db),true);
  const account=f.store.upsertAccount('perso',{name:'Nom privé à exclure',channel:'email',svc:'gmail',address:'private@example.test'});f.store.setAccountStatus(account.id,'À reconnecter','warn');f.store.setSync(account.id,{status:'error',error:'refresh_token=secret-never-log',lastSyncAt:new Date(f.now-3600000).toISOString()});
  const h=f.health();assert.equal(h.database.status,'ok');assert.equal(h.status,'attention');assert.equal(h.connectors.find(c=>c.provider==='gmail').needsReconnect,1);assert.equal(h.backups.status,'unconfigured');
  assert.doesNotMatch(JSON.stringify(h),/private@example|Nom privé|refresh_token|secret-never-log/);
  assert.equal(f.health({disk:()=>({bavail:1,bsize:1,blocks:100})}).storage.status,'low');
  f.close();assert.equal(databaseReady(f.db),false);assert.equal(f.health().status,'unavailable');
});
test('sauvegarde : absence, ancienneté, horloge future et métadonnées invalides ; aucun faux succès hors site',t=>{
  const f=fixture(t),file=join(f.dir,'status.json'),config={backupStatusFile:file};
  assert.equal(f.health({config}).backups.status,'missing');
  const good={version:1,createdAt:f.now-1000,sha256:'a'.repeat(64),bytes:1000};writeFileSync(file,JSON.stringify(good));let h=f.health({config});assert.equal(h.backups.status,'ok');assert.equal(h.backups.offsite,'unverified');assert.equal(h.backups.restoreTest,'unverified');
  writeFileSync(file,JSON.stringify({...good,createdAt:f.now-28*3600000}));assert.equal(f.health({config}).backups.status,'stale');
  writeFileSync(file,JSON.stringify({...good,createdAt:f.now+3600000,secret:'never-echo'}));h=f.health({config});assert.equal(h.backups.status,'invalid');assert.doesNotMatch(JSON.stringify(h),/never-echo/);
  writeFileSync(join(f.dir,RESTORE_HOLD),'{}');h=f.health({config:{connectorsEnabled:true}});assert.equal(h.restoreHeld,true);assert.equal(h.connectors.every(c=>c.enabled===false),true);
});
test('HTTP : readiness minimal public 503 si DB indisponible ; détails réservés au propriétaire',async t=>{
  const f=fixture(t);let ready=false;
  const auth={handle:async()=>false,requireSession:req=>{if(req.headers.cookie!=='fake-owner')throw new HttpError(401,'Connexion requise','auth_required');return{id:'fake-owner'};},assertMutation(){},assertRecent(){}};
  const server=createApp({store:f.store,ai:{configured:false},ownerName:'Fictif',auth,readiness:()=>({ok:ready,secret:'must-not-leak'}),operations:()=>f.health()});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  let r=await fetch(base+'/api/ready');assert.equal(r.status,503);assert.deepEqual(await r.json(),{ok:false});
  r=await fetch(base+'/api/ops/health');assert.equal(r.status,401);
  ready=true;r=await fetch(base+'/api/ready');assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});
  r=await fetch(base+'/api/ops/health',{headers:{cookie:'fake-owner'}});assert.equal(r.status,200);assert.equal((await r.json()).database.status,'ok');
});
test('configurations de supervision bornées, schéma futur refusé avant migrations',t=>{
  assert.throws(()=>readConfig({OPS_BACKUP_MAX_AGE_HOURS:'-1'}),/Configuration/);
  assert.throws(()=>readConfig({OPS_SYNC_STALE_MINUTES:'0'}),/Configuration/);
  const f=fixture(t);f.db.exec('PRAGMA user_version=999');assert.throws(()=>openDatabase(join(f.dir,'relay.db')),/plus récent/);
});
