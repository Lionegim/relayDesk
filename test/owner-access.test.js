import {test} from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {createApp} from '../src/http/app.js';
import {HttpError} from '../src/http/errors.js';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createSessionAccess} from '../src/http/session-access.js';
import {setup,connected} from './helpers/fake-google.js';
import {fakeMicrosoft,ALL_SCOPES} from './outlook-helpers.js';
import {createMicrosoftOAuth} from '../src/providers/outlook/oauth.js';
import {createOutlookSync} from '../src/providers/outlook/sync.js';
import {createOutlookOutbox} from '../src/providers/outlook/outbox.js';
import {createGmailOutbox} from '../src/providers/gmail/outbox.js';
import {GMAIL_SCOPES} from '../src/providers/gmail/oauth.js';
import {setupWhatsApp,linkedAccount} from './whatsapp-helpers.js';

// Double de l'interface auth uniquement : le module OIDC/session fait l'objet de ses propres tests.
async function serve(t,{store,providers={},gmail=null}) {
 let base;const revoked=new Set();
 const auth={
  async handle(){return false;},
  requireSession(req){const id=req.headers['x-test-device'];if(!['a','b','c'].includes(id)||revoked.has(id))throw new HttpError(401,'Connexion requise','unauthorized');return{id,csrfToken:`csrf-${id}`};},
  assertMutation(req,s){if(req.headers.origin!==base || req.headers['x-csrf-token']!==s.csrfToken)throw new HttpError(403,'Requête refusée','csrf');},
  assertRecent(){},
 };
 const hosts=[],app=createApp({store,providers,gmail,ai:{configured:false},auth,allowedHosts:hosts});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;hosts.push(new URL(base).host);
 t.after(async()=>{app.closeIdleConnections();await new Promise(r=>app.close(r));});
 const call=(method,path,body,device='a',extra={})=>fetch(base+path,{method,redirect:'manual',headers:{...(device?{'x-test-device':device}:{}),origin:base,'x-csrf-token':`csrf-${device}`,...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
 return{base,call,revoked};
}

test('accès HTTP : contenus, mémoire, QR, OAuth et ressources applicatives privés ; santé et connexion seules publiques',async t=>{
 const db=openDatabase(':memory:');seedIfEmpty(db);t.after(()=>db.close());const store=createStore(db);
 const {call,base}=await serve(t,{store});
 for(const path of ['/api/state','/api/messages/1','/api/messages/1/memory','/api/whatsapp/links/fake','/oauth/google/callback?code=fake','/js/app.js','/index.html'])assert.equal((await call('GET',path,null,null)).status,401,path);
 assert.equal((await call('GET','/',null,null)).headers.get('location'),'/login');
 assert.equal((await call('GET','/login',null,null)).status,200);
 assert.deepEqual(await(await call('GET','/api/health',null,null)).json(),{ok:true});
 const badHost=await new Promise((resolve,reject)=>{const req=request(base+'/api/state',{headers:{host:'attacker.example','x-test-device':'a','x-forwarded-host':'127.0.0.1'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,403);
 for(const headers of [{'x-csrf-token':'bad'},{origin:'https://attacker.example'},{origin:''}])assert.equal((await call('PATCH','/api/messages/1',{unread:false},'a',headers)).status,403);
 assert.equal((await call('GET','/oauth/google/start?profile=perso&name=test&win=7')).status,405);
});

test('approbation : deux appareils, contenu modifié, expiration et usage unique restent séparés',()=>{
 let now=100;const access=createSessionAccess({clock:()=>now}),a={id:'a'},b={id:'b'},input={text:'Exactement ceci',mode:'new',to:'test@example.test',cc:'',subject:'Fictif'};
 const preview=access.rememberPreview(a,7,input,{digest:'digest-fictif'}),send={...input,...preview};
 assert.throws(()=>access.consumePreview(b,7,send),e=>e.status===409);
 assert.throws(()=>access.consumePreview(a,7,{...send,text:'Autre texte'}),e=>e.status===409);
 access.consumePreview(a,7,send);assert.throws(()=>access.consumePreview(a,7,send),e=>e.status===409);
 const expired=access.rememberPreview(a,7,input,{digest:'digest-fictif'});now+=300001;assert.throws(()=>access.consumePreview(a,7,{...input,...expired}),e=>e.status===409);
 access.rememberOAuth(a,'gmail','https://issuer.example.test/?state=test');assert.throws(()=>access.consumeOAuth(b,'gmail','test'),e=>e.status===403);access.consumeOAuth(a,'gmail','test');assert.throws(()=>access.consumeOAuth(a,'gmail','test'),e=>e.status===403);
});

test('Gmail et Outlook fictifs : aperçu lié appareil, aucun double envoi et session révoquée refusée',async t=>{
 const ctx=setup(),google=await connected(ctx,Object.values(GMAIL_SCOPES)),ms=fakeMicrosoft({scope:ALL_SCOPES}),oauth=createMicrosoftOAuth({clientId:'fake',fetchImpl:ms.fetch});
 const sync=createOutlookSync({...ctx,oauth,fetchImpl:ms.fetch,log:{}});const {account,job}=sync.connect({profileId:'perso',name:'Test Microsoft',windowDays:7,refreshToken:'fake',email:'test@example.test',scopes:ALL_SCOPES.split(' ')});await job;
 t.after(()=>{sync.stop();ctx.sync.stop();ctx.db.close();});
 const {call,revoked}=await serve(t,{store:ctx.store,providers:{gmail:{sync:ctx.sync,outbox:createGmailOutbox(ctx)},outlook:{sync,outbox:createOutlookOutbox({...ctx,sync})}}});
 for(const acc of [google,account]) {
  const made=await(await call('POST','/api/drafts',{accountId:acc.id})).json(),path=`/api/messages/${made.id}/send`,input={mode:'new',text:'Test sans envoi réel',to:'test@example.test',cc:'',subject:'Fictif'};
  const p=await(await call('POST',path+'/preview',input)).json();assert.equal(typeof p.approvalToken,'string');
  const send={...input,digest:p.digest,approvalToken:p.approvalToken};assert.equal((await call('POST',path,send,'b')).status,409);
  assert.equal((await call('POST',path,{...send,text:'Texte modifié'})).status,409);
  assert.equal((await call('POST',path,send)).status,200);assert.equal((await call('POST',path,send)).status,409);
 }
 assert.equal(ctx.g.sent.length,1);assert.equal(ms.sent.length,1);revoked.add('a');assert.equal((await call('GET','/api/state')).status,401);
});

test('WhatsApp fictif : l’aperçu exact reste lié à l’appareil et toute reprise exige un nouvel aperçu',async t=>{
 const ctx=await setupWhatsApp(),{accountId,sock}=await linkedAccount(ctx);t.after(()=>{ctx.wa.sync.stop();ctx.db.close();});
 const id=ctx.db.prepare('SELECT id FROM messages WHERE account_id=?').get(accountId).id;
 const {call}=await serve(t,{store:ctx.store,providers:{whatsapp:ctx.wa}}),path=`/api/messages/${id}/send`,input={mode:'reply',text:'Réponse entièrement fictive'};
 const p=await(await call('POST',path+'/preview',input)).json(),send={...input,digest:p.digest,approvalToken:p.approvalToken};
 assert.equal((await call('POST',path,send,'b')).status,409);
 const replies=await Promise.all([call('POST',path,send),call('POST',path,send)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal(sock.sent.length,1);
});


test('limitation : lectures QR indépendantes des mutations et compteur borné par fenêtre',()=>{
 let now=0;const access=createSessionAccess({clock:()=>now}),session={id:'qr-device'};
 for(let i=0;i<40;i++)access.limit(session,'/api/whatsapp/links/test','GET');
 for(let i=0;i<20;i++)access.limit(session,'/api/messages/1/send','POST');
 assert.throws(()=>access.limit(session,'/api/messages/1/send','POST'),e=>e.status===429);
 now=60001;access.limit(session,'/api/messages/1/send','POST');
});


test('OAuth messagerie : démarrage POST protégé et retour lié au même appareil, état consommé une fois',async t=>{
 const db=openDatabase(':memory:');seedIfEmpty(db);t.after(()=>db.close());const store=createStore(db);
 const gmail={redirectUri:'http://127.0.0.1/oauth/google/callback',oauth:{configured:true,start:()=> 'https://google.example.test/authorize?state=synthetic-state'},sync:{permissions:()=>[]}};
 const {call}=await serve(t,{store,gmail});
 const start=await call('POST','/api/oauth/google/start',{profile:'perso',name:'Compte fictif',win:7,perms:'read'});assert.equal(start.status,200);assert.equal((await start.json()).url,'https://google.example.test/authorize?state=synthetic-state');
 const callback='/oauth/google/callback?state=synthetic-state&error=access_denied';
 assert.equal((await call('GET',callback,null,'b')).status,403);
 assert.equal((await call('GET',callback)).status,302);
 assert.equal((await call('GET',callback)).status,403);
});
