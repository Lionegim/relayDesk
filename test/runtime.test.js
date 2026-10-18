import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {readConfig} from '../src/runtime/config.js';
import {createRuntime} from '../src/runtime/lifecycle.js';
import {createVault} from '../src/secrets.js';
import {acquireInstanceLock} from '../src/runtime/instance-lock.js';

const KEY='12'.repeat(32),ROOT=fileURLToPath(new URL('../',import.meta.url));
const temp=t=>{const dir=mkdtempSync(join(tmpdir(),'relay-runtime-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const config=(dir,extra={})=>readConfig({DATA_DIR:dir,PORT:'0',RELAY_CONNECTORS_ENABLED:'false',RELAY_AI_ENABLED:'false',RELAY_SECRET_KEY:KEY,...extra});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const waitFor=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('délai de test dépassé');};

test('runtime hors réseau : santé minimale, adaptateurs absents et appels IA/connexion refusés',async t=>{
 const r=createRuntime(config(temp(t)));await r.start();t.after(()=>r.stop());
 const health=await fetch(r.url+'/api/health');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
 const state=await (await fetch(r.url+'/api/state')).json();assert.deepEqual(state.integrations,{});assert.equal(state.ai.configured,false);
 const link=await fetch(r.url+'/api/whatsapp/links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId:'perso',name:'Faux',windowDays:7})});assert.equal(link.status,503);
 const ai=await fetch(r.url+'/api/ai/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messageId:1,tone:'Bref'})});assert.equal(ai.status,503);
 await r.stop();await r.stop();assert.equal(r.state,'stopped');await assert.rejects(r.start(),/arrêté/);
});

test('runtime hébergé verrouillé avant authentification : aucun fichier, aucune écoute, aucun fournisseur',async t=>{
 const dir=join(temp(t),'untouched');let touched=false;
 const c=config(dir,{RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',PORT:'4310'});
 const r=createRuntime(c,{providerFactory:()=>{touched=true;}});
 await assert.rejects(r.start(),e=>e.code==='hosted_not_ready');assert.equal(touched,false);assert.equal(existsSync(dir),false);await r.stop();
});

test('redémarrage : données fictives, brouillon, mémoire et secrets chiffrés persistent avec identité stable',async t=>{
 const dir=temp(t),c=config(dir);let r=createRuntime(c);await r.start();
 const a=r.store.upsertAccount('perso',{name:'Test uniquement',channel:'whatsapp',svc:'whatsapp',address:'+33100000000'});
 const m=r.store.getMessage(1);const id=r.store.upsertThread(a.id,{...m,externalId:'33100000001@s.whatsapp.net',body:'Texte synthétique',from:'Contact test',trail:[],count:1});
 r.store.rememberReply(id,'Salut, voici mon exemple de test !');r.store.saveDraft(id,'Brouillon fictif');
 const before=r.store.getReplyMemory(id,{internal:true});
 const vault=createVault(Buffer.from(KEY,'hex'));r.store.putSecret(a.id,vault.seal(a.id,{refreshToken:'test-token-never-valid',scopes:[]}));
 r.store.waAuthSet(a.id,'creds','',vault.seal(a.id,{t:'creds',i:'',v:'{"me":{"id":"33100000000:1@s.whatsapp.net"}}'}));
 const sealed=r.store.waAuthGet(a.id,'creds','');await r.stop();
 r=createRuntime(c);await r.start();t.after(()=>r.stop());
 assert.equal(r.store.getMessage(id).draft.text,'Brouillon fictif');assert.equal(r.store.getReplyMemory(id,{internal:true}).identity,before.identity);assert.equal(r.store.getReplyMemory(id).sampleCount,1);
 assert.deepEqual(r.store.waAuthGet(a.id,'creds',''),sealed);assert.equal(vault.open(a.id,r.store.getSecret(a.id)).refreshToken,'test-token-never-valid');
 assert.equal((await (await fetch(r.url+'/api/state')).json()).integrations.whatsapp,undefined,'aucune reprise réseau des faux identifiants');
});

test('clé invalide ou absente : refus avant migration et récupération du verrou pour la bonne clé',async t=>{
 const dir=temp(t);const r=createRuntime(config(dir));await r.start();
 const a=r.store.upsertAccount('perso',{name:'Faux compte',channel:'email',svc:'gmail',address:'test@example.test'});r.store.putSecret(a.id,createVault(Buffer.from(KEY,'hex')).seal(a.id,{refreshToken:'synthetic'}));await r.stop();
 const before=new DatabaseSync(join(dir,'relay.db'));const version=before.prepare('pragma user_version').get().user_version;before.close();
 const wrong=createRuntime(config(dir,{RELAY_SECRET_KEY:'13'.repeat(32)}));await assert.rejects(wrong.start(),/ne correspond pas/);
 const missing=createRuntime(config(dir,{RELAY_SECRET_KEY:''}));await assert.rejects(missing.start(),/absente/);
 const check=new DatabaseSync(join(dir,'relay.db'));assert.equal(check.prepare('pragma user_version').get().user_version,version);check.close();
 const valid=createRuntime(config(dir));await valid.start();await valid.stop();
});

test('arrêt : drainer HTTP et tâches avant SQLite, sans déconnexion fournisseur',async t=>{
 const dir=temp(t),entered=defer(),release=defer(),events=[];
 const r=createRuntime(config(dir),{
  providerFactory:async({store})=>({providers:{},syncs:[{start(){events.push('start');},pause(){events.push('pause');},async drain(){assert.equal(store.db.prepare('SELECT 1 AS n').get().n,1);events.push('drain');},stop(){events.push('stop');}}]}),
  appFactory:({store})=>createServer(async(req,res)=>{entered.resolve();await release.promise;store.saveDraft(1,'Écriture terminée après début arrêt');events.push('write');res.end('ok');}),
 });
 await r.start();const request=fetch(r.url);await entered.promise;const stopping=r.stop();await new Promise(r=>setTimeout(r,20));assert.equal(r.state,'stopping');assert.ok(!events.includes('stop'));
 release.resolve();assert.equal(await (await request).text(),'ok');await stopping;
 assert.ok(events.indexOf('write')<events.indexOf('stop'));assert.equal(r.state,'stopped');
 const db=new DatabaseSync(join(dir,'relay.db'));assert.equal(db.prepare('SELECT draft_text FROM messages WHERE id=1').get().draft_text,'Écriture terminée après début arrêt');db.close();
});

test('délai d’arrêt : ne pas libérer le verrou ni fermer SQLite sous une requête active',async t=>{
 const dir=temp(t),entered=defer(),release=defer();const r=createRuntime(config(dir,{SHUTDOWN_TIMEOUT_MS:'100'}),{
  appFactory:()=>createServer(async(req,res)=>{entered.resolve();await release.promise;res.end('terminé');}),
 });await r.start();const request=fetch(r.url);await entered.promise;
 await assert.rejects(r.stop(),e=>e.code==='shutdown_timeout');assert.equal(r.db.prepare('SELECT 1 AS n').get().n,1);assert.throws(()=>acquireInstanceLock(dir));
 release.resolve();await (await request).text();await waitFor(()=>r.state==='stopped');const unlock=acquireInstanceLock(dir);unlock();
});

test('échec écoute : stockage et verrou rendus pour une nouvelle tentative',async t=>{
 const dir=temp(t),occupied=createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
 const bad=createRuntime(config(dir,{PORT:String(occupied.address().port)}));await assert.rejects(bad.start(),e=>e.code==='EADDRINUSE');
 await new Promise(r=>occupied.close(r));const good=createRuntime(config(dir));await good.start();await good.stop();
});

function child(dir) {
 const cp=spawn(process.execPath,['--disable-warning=ExperimentalWarning',join(ROOT,'server.js')],{cwd:ROOT,env:{DATA_DIR:dir,PORT:'0',RELAY_SECRET_KEY:KEY,RELAY_AI_ENABLED:'false',RELAY_CONNECTORS_ENABLED:'false',DEMO_DATA:'1'},stdio:['ignore','pipe','pipe']});
 let output='',error='';cp.stdout.on('data',b=>output+=b);cp.stderr.on('data',b=>error+=b);
 return {cp,ready:async()=>{await waitFor(()=>output.includes('Relay Desk sur') || cp.exitCode!==null);assert.ok(output.includes('Relay Desk sur'),error);return output.match(/https?:\/\/\S+/)[0];},error:()=>error};
}
test('processus : seconde instance refusée ; SIGKILL libère le verrou et SIGTERM termine proprement',async t=>{
 const dir=temp(t);const first=child(dir);t.after(()=>{if(first.cp.exitCode===null)first.cp.kill('SIGKILL');});await first.ready();
 const second=child(dir);const [code]=await once(second.cp,'exit');assert.equal(code,1);assert.match(second.error(),/déjà utilisé/);assert.ok(!second.error().includes(KEY));
 const killed=once(first.cp,'exit');first.cp.kill('SIGKILL');await killed;
 const third=child(dir);t.after(()=>{if(third.cp.exitCode===null)third.cp.kill('SIGKILL');});const url=await third.ready();assert.equal((await fetch(url+'/api/health')).status,200);
 const exited=once(third.cp,'exit');third.cp.kill('SIGTERM');assert.equal((await exited)[0],0);
});


test('arrêt : une socket abandonnée garde son traitement suivi jusqu’à son écriture finale',async t=>{
 const dir=temp(t),entered=defer(),release=defer();let closed=false;
 const r=createRuntime(config(dir),{appFactory:({store})=>createServer(async(req,res)=>{
  req.socket.once('close',()=>{closed=true;});entered.resolve();await release.promise;
  store.saveDraft(1,'Traitement après abandon');res.end('ok');
 })});await r.start();
 const request=httpRequest(r.url);request.on('error',()=>{});request.end();await entered.promise;request.destroy();await waitFor(()=>closed);
 const stopping=r.stop();await new Promise(r=>setTimeout(r,20));assert.equal(r.state,'stopping');assert.equal(r.db.prepare('SELECT 1 AS n').get().n,1);assert.throws(()=>acquireInstanceLock(dir));
 release.resolve();await stopping;assert.equal(r.state,'stopped');
 const db=new DatabaseSync(join(dir,'relay.db'));assert.equal(db.prepare('SELECT draft_text FROM messages WHERE id=1').get().draft_text,'Traitement après abandon');db.close();
});
