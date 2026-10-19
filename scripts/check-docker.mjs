// Recette locale exclusivement fictive. Aucun .env, port publié, connecteur ou accès réseau.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const image=process.argv[2] || 'relay-desk:test-runtime';
const prefix=`relay-test-${randomUUID().slice(0,8)}`;
const data=`${prefix}-data`,key=`${prefix}-key`,restored=`${prefix}-restore`;
const containers=[];
function docker(args,{ok=true}={}) {
 const result=spawnSync('docker',args,{encoding:'utf8',timeout:60000});
 if(result.error) throw result.error;
 if(ok && result.status!==0) throw new Error(`docker ${args[0]} : ${result.stderr || result.stdout}`);
 return result;
}
const run=(volume,args=[])=>['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m','-v',`${volume}:/data`,'-v',`${key}:/run/relay-secrets:ro`,...args];
const environment=['-e','RELAY_MODE=local','-e','HOST=0.0.0.0','-e','PUBLIC_BASE_URL=http://127.0.0.1:4311','-e','RELAY_SECRET_KEY_FILE=/run/relay-secrets/key','-e','RELAY_CONNECTORS_ENABLED=false','-e','RELAY_AI_ENABLED=false','-e','DEMO_DATA=1'];
const exec=(name,source)=>docker(['exec',name,'node','--input-type=module','-e',source]);
const cold=(volume,source)=>docker([...run(volume),...environment,'--entrypoint','node',image,'--input-type=module','-e',source]);
async function start(volume,extraEnv=[]) {
 const name=`${prefix}-${containers.length}`;containers.push(name);
 docker([...run(volume,['-d','--name',name,'--init']).filter(x=>x!=='--rm'),...environment,...extraEnv,image]);
 for(let n=0;n<100;n++) {
  const check=docker(['exec',name,'node','deploy/healthcheck.mjs'],{ok:false});
  if(check.status===0) return name;
  if(docker(['inspect','-f','{{.State.Running}}',name]).stdout.trim()!=='true') throw new Error(docker(['logs',name]).stderr);
  await new Promise(r=>setTimeout(r,50));
 }
 throw new Error('Santé Docker indisponible');
}
function stop(name) {
 docker(['stop','-t','10',name]);
 assert.equal(docker(['inspect','-f','{{.State.ExitCode}}',name]).stdout.trim(),'0','SIGTERM propre');
}
const fixture=`
 import assert from 'node:assert/strict';
 import {openDatabase} from './src/db/index.js';
 import {createStore} from './src/store.js';
 import {createVault,loadKey} from './src/secrets.js';
 import {acquireInstanceLock} from './src/runtime/instance-lock.js';
 const unlock=acquireInstanceLock('/data'),db=openDatabase('/data/relay.db'),store=createStore(db);
 const vault=createVault(loadKey({keyFile:'/run/relay-secrets/key',allowCreate:false}));
 try {
`;
const close=`}finally{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();unlock();}`;
try {
 for(const volume of [data,key,restored]) docker(['volume','create',volume]);
 docker(['run','--rm','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','-v',`${key}:/secrets`,'--entrypoint','node',image,'-e',"const fs=require('node:fs');fs.writeFileSync('/secrets/key',require('node:crypto').randomBytes(32).toString('base64'),{mode:0o400});fs.chownSync('/secrets/key',1000,1000)"]);
 let name=await start(data);
 exec(name,`import assert from 'node:assert/strict';import fs from 'node:fs';assert.notEqual(process.getuid(),0);assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+/);assert.throws(()=>fs.writeFileSync('/app/forbidden','x'));assert.throws(()=>fs.writeFileSync('/etc/forbidden','x'));assert.throws(()=>fs.writeFileSync('/run/relay-secrets/key','x'));assert.equal(fs.existsSync('/data/secret.key'),false);assert.equal(fs.existsSync('/app/.env'),false);const r=await fetch('http://127.0.0.1:4310/api/health');assert.deepEqual(await r.json(),{ok:true});const state=await(await fetch('http://127.0.0.1:4310/api/state')).json();assert.deepEqual(state.integrations,{});assert.equal(state.ai.configured,false);`);
 const second=docker([...run(data),...environment,image],{ok:false});assert.equal(second.status,1);assert.match(second.stderr,/instance|utilisé|verrou/i);
 stop(name);
 cold(data,fixture+`const a=store.upsertAccount('perso',{name:'Docker synthétique',channel:'whatsapp',svc:'whatsapp',address:'+33100000000'});const m=store.getMessage(1);const id=store.upsertThread(a.id,{...m,externalId:'33100000001@s.whatsapp.net',body:'Texte fictif',from:'Contact test',trail:[],count:1});store.rememberReply(id,'Salut, exemple de test !');store.saveDraft(id,'Brouillon Docker fictif');store.putSecret(a.id,vault.seal(a.id,{refreshToken:'synthetic-never-valid'}));store.waAuthSet(a.id,'creds','',vault.seal(a.id,{t:'creds',i:'',v:'fake-credentials'}));const fs=await import('node:fs');fs.writeFileSync('/data/test-expectation.json',JSON.stringify({id,accountId:a.id,identity:store.getReplyMemory(id,{internal:true}).identity,draftVersion:store.getMessage(id).draftVersion}));`+close);
 const verify=fixture+`const fs=await import('node:fs');const e=JSON.parse(fs.readFileSync('/data/test-expectation.json'));assert.equal(store.getMessage(e.id).draft.text,'Brouillon Docker fictif');assert.equal(store.getMessage(e.id).draftVersion,e.draftVersion);assert.equal(store.getReplyMemory(e.id,{internal:true}).identity,e.identity);assert.equal(store.getReplyMemory(e.id).sampleCount,1);assert.equal(vault.open(e.accountId,store.getSecret(e.accountId)).refreshToken,'synthetic-never-valid');assert.equal(vault.open(e.accountId,store.waAuthGet(e.accountId,'creds','')).v,'fake-credentials');`+close;
 name=await start(data);docker(['kill','--signal','SIGKILL',name]);
 name=await start(data);stop(name);cold(data,verify);
 // Initialiser les droits du volume neuf depuis /data (uid 1000), avant de le monter sur /restore.
 cold(restored,"import fs from 'node:fs';fs.accessSync('/data',fs.constants.W_OK);");
 // Copie à froid après arrêt et checkpoint, jamais d'une base active ; aucune ancienne session n'est reprise.
 docker([...run(data,['-v',`${restored}:/restore`]),'--entrypoint','node',image,'-e',"const fs=require('node:fs');for(const file of ['relay.db','test-expectation.json'])fs.copyFileSync('/data/'+file,'/restore/'+file)"]);
 name=await start(restored);stop(name);cold(restored,verify);
 const hosted=docker([...run(restored),...environment,'-e','RELAY_MODE=hosted','-e','PUBLIC_BASE_URL=https://relay.example.test',image],{ok:false});assert.equal(hosted.status,1);assert.match(hosted.stderr,/AUTH_|authentification|OIDC/);
 // Hébergé OIDC configuré uniquement avec des valeurs fictives : serveur isolé sans réseau ni port publié.
 name=await start(restored,['-e','RELAY_MODE=hosted','-e','PUBLIC_BASE_URL=https://relay.example.test','-e','AUTH_MODE=oidc','-e','AUTH_ISSUER=https://identity.example.test/realms/test','-e','AUTH_CLIENT_ID=synthetic-client','-e','AUTH_CLIENT_SECRET=synthetic-not-a-real-secret','-e','AUTH_OWNER_SUB=synthetic-owner','-e','AUTH_MFA_ACR=relay-mfa']);
 exec(name,`import assert from 'node:assert/strict';import {request} from 'node:http';const call=path=>new Promise((resolve,reject)=>{const r=request({host:'127.0.0.1',port:4310,path,headers:{host:'relay.example.test'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});for(const path of ['/api/state','/api/messages/1','/api/whatsapp/links/fake','/index.html','/auth/sessions'])assert.equal(await call(path),401,path);assert.equal(await call('/api/health'),200);assert.equal(await call('/'),302);assert.equal(await call('/login'),200);for(const path of ['/js/app.js','/manifest.webmanifest','/sw.js','/offline.html','/icons/icon-192.png'])assert.equal(await call(path),200,path);`);
 stop(name);
 console.log('Docker : non-root, lecture seule, zéro réseau, clé séparée, verrou inter-conteneurs, SIGKILL/reprise, brouillon/mémoire/secrets persistants et restauration fictive validés. Hébergé sans OIDC refusé ; avec configuration fictive, API/QR/contenus privés et connexion publique vérifiés.');
} finally {
 for(const name of containers) docker(['rm','-f',name],{ok:false});
 for(const volume of [data,key,restored]) docker(['volume','rm',volume],{ok:false});
}
