// Recette d'exploitation exclusivement synthétique : volumes éphémères, aucun port ni réseau.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const image=process.argv[2]||'relay-desk:test-runtime',prefix='relay-ops-'+randomUUID().slice(0,8);
const volumes=['data','keys','work','vault'].map(s=>prefix+'-'+s),containers=[];
const [data,keys,work,vault]=volumes;
function docker(args,ok=true){const r=spawnSync('docker',args,{encoding:'utf8',timeout:60000});if(r.error)throw r.error;if(ok&&r.status!==0)throw new Error(r.stderr||r.stdout);return r;}
const security=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m'];
const mounts=['-v',data+':/data','-v',work+':/work','-v',keys+':/run/ops-keys:ro'];
const env=['-e','HOST=0.0.0.0','-e','PORT=4310','-e','RELAY_SECRET_KEY_FILE=/run/ops-keys/vault','-e','RELAY_CONNECTORS_ENABLED=false','-e','RELAY_AI_ENABLED=false','-e','DEMO_DATA=1'];
const admin=(args,ok=true)=>docker(['run','--rm',...security,...mounts,'--entrypoint','node',image,...args],ok);
const cli=(args,ok=true)=>admin(['scripts/backup.mjs',...args],ok);
const keyArgs=['--backup-key-file','/run/ops-keys/backup','--vault-key-file','/run/ops-keys/vault'];
const exec=(name,source)=>docker(['exec',name,'node','--input-type=module','-e',source]);
async function start(dir='/data',extra=[]){
 const name=prefix+'-'+containers.length;containers.push(name);
 // Le runtime ne reçoit jamais la clé de sauvegarde, même pendant cette recette.
 docker(['run','-d','--name',name,'--init',...security,'-v',data+':/data','-v',work+':/work','-v',vault+':/key-source:ro',...env,'-e','RELAY_SECRET_KEY_FILE=/key-source/vault','-e','DATA_DIR='+dir,...extra,image]);
 for(let i=0;i<100;i++){if(docker(['exec',name,'node','deploy/healthcheck.mjs'],false).status===0)return name;if(docker(['inspect','-f','{{.State.Running}}',name]).stdout.trim()!=='true')throw new Error(docker(['logs',name]).stderr);await new Promise(r=>setTimeout(r,50));}throw new Error('Runtime fictif indisponible');
}
function stop(name){docker(['stop','-t','10',name]);assert.equal(docker(['inspect','-f','{{.State.ExitCode}}',name]).stdout.trim(),'0');}
try{
 for(const volume of volumes)docker(['volume','create',volume]);
 docker(['run','--rm',...security,'--user','0:0','--cap-add','CHOWN','-v',keys+':/keys','-v',work+':/work','-v',vault+':/vault','--entrypoint','node',image,'-e',"const fs=require('node:fs'),crypto=require('node:crypto');fs.chmodSync('/work',0o700);fs.chownSync('/work',1000,1000);for(const name of ['vault','backup','wrong']){const value=crypto.randomBytes(32).toString('base64');fs.writeFileSync('/keys/'+name,value,{mode:0o400});fs.chownSync('/keys/'+name,1000,1000);if(name==='vault'){fs.writeFileSync('/vault/vault',value,{mode:0o400});fs.chownSync('/vault/vault',1000,1000);}}"]);
 let name=await start();
 exec(name,`import {DatabaseSync} from 'node:sqlite';import {createStore} from './src/store.js';import {createVault,loadKey} from './src/secrets.js';const db=new DatabaseSync('/data/relay.db');const s=createStore(db),a=s.upsertAccount('perso',{name:'Compte synthétique',channel:'email',svc:'gmail',address:'fake@example.test'}),v=createVault(loadKey({keyFile:'/key-source/vault',allowCreate:false}));s.putSecret(a.id,v.seal(a.id,{refreshToken:'synthetic-token'}));const id=s.upsertThread(a.id,{...s.getMessage(1),externalId:'fake-thread',body:'Texte fictif',from:'Contact fictif',trail:[],count:1});s.saveDraft(id,'Brouillon recette sauvegarde');s.rememberReply(id,'Salut recette fictive !');db.close();`);
 const created=JSON.parse(cli(['create','--data-dir','/data','--archive','/work/test.rlybak','--status-file','/work/status.json',...keyArgs]).stdout);
 assert.equal(created.version,1);assert.ok(created.bytes>512);assert.match(created.sha256,/^[a-f0-9]{64}$/);
 assert.equal(cli(['create','--data-dir','/data','--archive','/work/test.rlybak',...keyArgs],false).status,1);
 stop(name);
 const restored=JSON.parse(cli(['restore','--data-dir','/work/restored','--archive','/work/test.rlybak',...keyArgs]).stdout);assert.equal(restored.connectorsHeld,true);
 assert.equal(cli(['restore','--data-dir','/work/restored','--archive','/work/test.rlybak',...keyArgs],false).status,1);
 const bad=cli(['restore','--data-dir','/work/bad','--archive','/work/test.rlybak','--backup-key-file','/run/ops-keys/wrong','--vault-key-file','/run/ops-keys/vault'],false);assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/synthetic-token|Brouillon recette/);
 admin(['--input-type=module','-e',`import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {createStore} from './src/store.js';import {createVault,loadKey} from './src/secrets.js';assert.equal(fs.existsSync('/work/bad'),false);const bytes=fs.readFileSync('/work/test.rlybak');assert.equal(bytes.includes(Buffer.from('Brouillon recette sauvegarde')),false);assert.equal(bytes.includes(Buffer.from('synthetic-token')),false);const db=new DatabaseSync('/work/restored/relay.db'),s=createStore(db),v=createVault(loadKey({keyFile:'/run/ops-keys/vault',allowCreate:false}));const id=db.prepare("SELECT id FROM messages WHERE external_id='fake-thread'").get().id;assert.equal(s.getMessage(id).draft.text,'Brouillon recette sauvegarde');assert.equal(s.getReplyMemory(id).sampleCount,1);const a=db.prepare("SELECT id,status FROM accounts WHERE address='fake@example.test'").get();assert.equal(a.status,'À reconnecter');assert.equal(v.open(a.id,s.getSecret(a.id)).refreshToken,'synthetic-token');assert.equal(db.prepare('SELECT count(*) AS n FROM whatsapp_auth').get().n,0);db.close();`]);
 name=await start('/work/restored',['-e','RELAY_CONNECTORS_ENABLED=true','-e','RELAY_AI_ENABLED=true','-e','MISTRAL_API_KEY=synthetic-not-valid']);
 exec(name,`import assert from 'node:assert/strict';const s=await(await fetch('http://127.0.0.1:4310/api/state')).json();assert.deepEqual(s.integrations,{});const fs=await import('node:fs');assert.deepEqual(fs.readdirSync('/key-source'),['vault']);assert.equal(s.ai.configured,false);const h=await(await fetch('http://127.0.0.1:4310/api/ops/health')).json();assert.equal(h.restoreHeld,true);assert.equal(h.database.status,'ok');assert.equal(h.backups.offsite,'unverified');`);
 assert.equal(cli(['resume','--data-dir','/work/restored','--confirm-resume'],false).status,1);
 stop(name);assert.equal(cli(['resume','--data-dir','/work/restored'],false).status,1);assert.equal(JSON.parse(cli(['resume','--data-dir','/work/restored','--confirm-resume']).stdout).released,true);
 console.log('Docker exploitation : snapshot WAL actif, archive chiffrée, restauration complète, clés incorrectes et écrasement refusés, connecteurs/IA suspendus malgré environnement actif, reprise explicite à froid. Zéro réseau et aucun port publié.');
}finally{for(const name of containers)docker(['rm','-f',name],false);for(const volume of volumes)docker(['volume','rm',volume],false);}
