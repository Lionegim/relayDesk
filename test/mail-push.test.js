import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createVault} from '../src/secrets.js';
import {createMailPush,createGooglePushVerifier} from '../src/mail/push.js';
import {createApp} from '../src/http/app.js';
import {HttpError} from '../src/http/errors.js';
import {fakeGoogle,thread} from './helpers/fake-google.js';
import {fakeMicrosoft,ALL_SCOPES} from './outlook-helpers.js';
import {createGmailSync} from '../src/providers/gmail/sync.js';
import {createOutlookSync} from '../src/providers/outlook/sync.js';
import {readConfig} from '../src/runtime/config.js';

const DAY=86400000,until=async fn=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,5));assert.ok(fn(),'condition not reached');};
async function fixture(t) {
 const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});const store=createStore(db),vault=createVault(Buffer.alloc(32,24));let now=Date.now(),push,server,base,barrier,watchBarrier;
 const config={connectorsEnabled:true,publicBaseUrl:'https://relay.example.test',microsoftTenant:'tenant-test',mailPush:{gmailEnabled:true,outlookEnabled:true,gmailTopic:'projects/test-project/topics/gmail',gmailSubscription:'projects/test-project/subscriptions/gmail',gmailServiceAccount:'push@test-project.iam.gserviceaccount.com'}};
 const accounts={},providers={},calls={gmail:[],outlook:[]},notified={gmail:0,outlook:0},subscriptions=[];
 for(const service of ['gmail','outlook']) {
  const account=store.upsertAccount('perso',{name:service,channel:'email',svc:service,address:`owner@${service}.example.test`});accounts[service]=account;
  store.putSecret(account.id,vault.seal(account.id,{refreshToken:'fake-refresh',oauthBinding:`${service}-binding`,scopes:[]}));
  store.setAccountStatus(account.id,'Connecté','ok');store.setSync(account.id,{status:'ok',last_sync_at:new Date(now).toISOString(),history_id:'10'});
  const at=store.accountIdentity(account.id);
  const client={live:()=>store.hasAccount(account.id)&&store.accountIdentity(account.id)===at,
   gmail:{async post(path,body){calls.gmail.push({path,body});if(watchBarrier)await watchBarrier;return{expiration:now+7*DAY,historyId:'10'};}},
   graph:{async request(method,path,options={}){calls.outlook.push({method,path,...options});if(method==='GET')return{value:subscriptions};if(method==='DELETE'){const index=subscriptions.findIndex(s=>path.endsWith(s.id));if(index>=0)subscriptions.splice(index,1);return{};}if(method==='POST'){if(subscriptions.some(s=>s.resource===options.body.resource&&s.changeType===options.body.changeType))throw Object.assign(new Error(),{code:'conflict'});const sub={...options.body,id:`subscription-${subscriptions.length+1}`};subscriptions.push(sub);return sub;}const sub=subscriptions.find(s=>path.endsWith(s.id));if(!sub)throw Object.assign(new Error(),{code:'not_found'});Object.assign(sub,options.body);return sub;}}};
  providers[service]={oauth:{configured:true,mode:'web',binding:`${service}-binding`},sync:{permissions:()=>['read'],exclusive:async(id,fn)=>fn(client),async notify(){notified[service]++;if(barrier)await barrier;store.setSync(account.id,{status:'ok',last_sync_at:new Date(now).toISOString()});return true;}}};
 }
 const make=()=>createMailPush({config,store,vault,providers,clock:()=>now,log:{},verifyGoogle:async header=>{if(header!=='Bearer google-test')throw new HttpError(401,'Non autorisé','push_auth');}});
 push=make();
 server=createApp({store,ai:{configured:false},providers,push,auth:{handle:async()=>false,requireSession(){throw new HttpError(401,'Connexion requise','auth_required');}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{push.stop();await push.drain();server.closeLiveUpdates();await new Promise(r=>server.close(r));db.close();});
 const lease=service=>vault.open(accounts[service].id,store.getSecret(accounts[service].id)).mailPush;
 const post=async(service,body,{authorization='Bearer google-test',path=`/webhooks/${service}`}={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization},body:JSON.stringify(body)});
 const google=historyId=>({subscription:config.mailPush.gmailSubscription,message:{data:Buffer.from(JSON.stringify({emailAddress:accounts.gmail.address,historyId})).toString('base64url')}});
 const graph=(extra={})=>({value:[{subscriptionId:lease('outlook').subscriptionId,clientState:lease('outlook').clientState,tenantId:config.microsoftTenant,changeType:'created',...extra}]});
 const start=async()=>{push.start();await push.drain();push.tick();await push.drain();};
 return{db,store,vault,config,accounts,providers,calls,notified,subscriptions,lease,post,google,graph,start,make,get push(){return push;},replace(value){push=value;},advance(ms){now+=ms;},blockSync(value){barrier=value;},blockWatch(value){watchBarrier=value;}};
}

test('Google delivery verifies signature, issuer, audience and service-account identity',async()=>{
 const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='test';
 const verify=createGooglePushVerifier({keySet:createLocalJWKSet({keys:[jwk]}),audience:'https://relay.example.test/webhooks/gmail',email:'push@test-project.iam.gserviceaccount.com'});
 const token=async patch=>new SignJWT({email:'push@test-project.iam.gserviceaccount.com',email_verified:true,iss:'https://accounts.google.com',aud:'https://relay.example.test/webhooks/gmail',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...patch}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(keys.privateKey);
 await verify('Bearer '+await token({}));
 for(const patch of [{email:'other@test-project.iam.gserviceaccount.com'},{email_verified:false},{aud:'https://wrong.example.test'},{iss:'https://attacker.example.test'},{exp:1}])await assert.rejects(verify('Bearer '+await token(patch)),e=>e.status===401);
 await assert.rejects(verify('Bearer nonsense'),e=>e.status===401);
});

test('Gmail uses authenticated notifications, durable encrypted state and duplicate history coalescing',async t=>{
 const f=await fixture(t);await f.start();assert.equal(f.push.shouldPoll('gmail',f.accounts.gmail.id),false);
 assert.equal((await f.post('gmail',f.google('11'),{authorization:'Bearer forged'})).status,401);assert.equal(f.notified.gmail,1);
 assert.equal((await f.post('gmail',{...f.google('11'),subscription:'other'})).status,400);
 assert.equal((await f.post('gmail',f.google('11'))).status,202);await until(()=>f.notified.gmail===2);await f.push.drain();
 assert.equal(f.lease('gmail').processed,2);assert.ok(f.push.status(f.accounts.gmail.id).lastNotificationAt);
 await f.post('gmail',f.google('11'));await f.post('gmail',f.google('9'));await f.push.drain();assert.equal(f.notified.gmail,2);
 assert.doesNotMatch(JSON.stringify(f.store.snapshot()),/mailPush|clientState|fake-refresh|gmail-binding/);
 f.advance(11*60000);assert.equal(f.push.shouldPoll('gmail',f.accounts.gmail.id),true,'slow reconciliation remains as loss recovery');
});

test('Graph validation is plain text; forged state, wrong tenant and unknown subscription cannot sync',async t=>{
 const f=await fixture(t);await f.start();const validation=await f.post('outlook',{}, {path:'/webhooks/outlook?validationToken=opaque%3Ctest%3E'});
 assert.equal(validation.status,200);assert.match(validation.headers.get('content-type'),/text\/plain/);assert.equal(await validation.text(),'opaque<test>');
 for(const change of [{clientState:'forged'},{clientState:'é'.repeat(43)},{tenantId:'wrong'},{tenantId:5},{subscriptionId:'unknown'}])assert.equal((await f.post('outlook',f.graph(change))).status,202);
 assert.equal(f.notified.outlook,1);assert.equal((await f.post('outlook',{value:[null]})).status,400);
 assert.equal((await f.post('outlook',f.graph())).status,202);await until(()=>f.notified.outlook===2);await f.push.drain();assert.equal(f.lease('outlook').processed,2);
});

test('accepted notification survives a coordinator restart before processing',async t=>{
 const f=await fixture(t);await f.start();f.push.pause();await f.post('gmail',f.google('12'));assert.equal(f.notified.gmail,1);assert.equal(f.lease('gmail').revision,2);
 const restarted=f.make();f.push.stop();f.replace(restarted);await f.start();assert.equal(f.notified.gmail,2);assert.equal(f.lease('gmail').processed,2);
});

test('notification arriving during an in-flight sync is not acknowledged by the older sync',async t=>{
 const f=await fixture(t);await f.start();let release;f.blockSync(new Promise(r=>{release=r;}));
 await f.post('gmail',f.google('11'));await until(()=>f.notified.gmail===2);await f.post('gmail',f.google('12'));
 f.blockSync(null);release();await f.push.drain();assert.equal(f.lease('gmail').processed,2);assert.equal(f.lease('gmail').revision,3);
 f.push.tick();await f.push.drain();assert.equal(f.notified.gmail,3);assert.equal(f.lease('gmail').processed,3);
});

test('leases renew daily; Graph lifecycle removal recreates and reauthorization forces a fresh access token',async t=>{
 const f=await fixture(t);await f.start();const id=f.lease('outlook').subscriptionId;
 f.advance(DAY+1);f.push.tick();await f.push.drain();assert.equal(f.calls.gmail.length,2);
 assert.ok(f.calls.outlook.some(c=>c.method==='PATCH'&&c.forceRefresh===true));
 await f.post('outlook',f.graph({lifecycleEvent:'reauthorizationRequired'}));await f.push.drain();assert.equal(f.lease('outlook').status,'active');
 await f.post('outlook',f.graph({lifecycleEvent:'subscriptionRemoved'}));await f.push.drain();assert.equal(f.lease('outlook').status,'active');assert.notEqual(f.lease('outlook').subscriptionId,null);
 // Recovery may reuse a still-valid subscription returned by Graph; no duplicate is required.
 assert.ok(f.subscriptions.some(s=>s.id===id));
});

test('disabled push routes remain private, and hosted Pub/Sub configuration fails closed',async t=>{
 const f=await fixture(t);f.config.mailPush.gmailEnabled=false;
 assert.equal((await f.post('gmail',f.google('11'))).status,401);
 assert.throws(()=>readConfig({GMAIL_PUSH_ENABLED:'true'}),e=>e.code==='configuration_invalid');
});


test('restart catches up downtime without recreating healthy subscriptions',async t=>{
 const f=await fixture(t);await f.start();const id=f.lease('outlook').subscriptionId;
 const restarted=f.make();f.push.stop();f.replace(restarted);await f.start();
 assert.equal(f.notified.gmail,2);assert.equal(f.notified.outlook,2);
 assert.equal(f.calls.gmail.length,1);assert.equal(f.lease('outlook').subscriptionId,id);assert.equal(f.subscriptions.length,1);
});

test('completion from the old OAuth connection cannot acknowledge the replacement connection',async t=>{
 const f=await fixture(t);await f.start();const old=f.lease('gmail').incarnation;let release;
 f.blockSync(new Promise(r=>{release=r;}));await f.post('gmail',f.google('11'));await until(()=>f.notified.gmail===2);
 const id=f.accounts.gmail.id,cred=f.vault.open(id,f.store.getSecret(id));delete cred.mailPush;
 f.store.putSecret(id,f.vault.seal(id,cred));f.push.tick();await until(()=>f.lease('gmail')?.status==='active');
 assert.notEqual(f.lease('gmail').incarnation,old);assert.equal(f.lease('gmail').processed,0);
 f.blockSync(null);release();await f.push.drain();assert.equal(f.lease('gmail').processed,0);
 f.push.tick();await f.push.drain();assert.equal(f.lease('gmail').processed,f.lease('gmail').revision);
});

test('Outlook push requires a canonical tenant GUID instead of an OAuth alias',()=>{
 const env={RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',RELAY_SECRET_KEY:'11'.repeat(32),RELAY_ALLOWED_ACCOUNTS:'outlook:owner@example.test',AUTH_MODE:'oidc',AUTH_ISSUER:'https://identity.example.test/realms/relay',AUTH_CLIENT_ID:'test-client',AUTH_CLIENT_SECRET:'synthetic-only',AUTH_OWNER_SUB:'test-owner',AUTH_MFA_ACR:'relay-mfa',OUTLOOK_PUSH_ENABLED:'true'};
 for(const tenant of ['common','organizations','example.test',''])assert.throws(()=>readConfig({...env,MICROSOFT_TENANT:tenant}),/GUID/);
 assert.equal(readConfig({...env,MICROSOFT_TENANT:'11111111-2222-3333-4444-555555555555'}).mailPush.outlookEnabled,true);
});


test('provider notifications import new Gmail history and Outlook delta through the real sync workers without sending',async t=>{
 const f=await fixture(t),g=fakeGoogle({threads:{}}),ms=fakeMicrosoft({scope:ALL_SCOPES});let gmailChanged=false;
 for(const service of ['gmail','outlook']){
  const account=f.accounts[service],provider=f.providers[service];provider.oauth.refresh=async()=>({access_token:'at',expires_in:3600});
  const cred=f.vault.open(account.id,f.store.getSecret(account.id));
  f.store.putSecret(account.id,f.vault.seal(account.id,{...cred,email:account.address,scopes:service==='gmail'?['https://www.googleapis.com/auth/gmail.readonly']:ALL_SCOPES.split(' ')}));
  const fetchImpl=service==='gmail'?async(url,init)=>{
   if(new URL(url).pathname.endsWith('/history'))return new Response(JSON.stringify({history:gmailChanged?[{messagesAdded:[{message:{threadId:'push-new'}}]}]:[],historyId:gmailChanged?'11':'10'}));
   return g.fetch(url,init);
  }:ms.fetch;
  const sync=(service==='gmail'?createGmailSync:createOutlookSync)({store:f.store,vault:f.vault,oauth:provider.oauth,fetchImpl,log:{}});
  provider.sync.notify=sync.notify;t.after(()=>sync.stop());
 }
 await f.start();assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n,0);
 g.threads['push-new']=thread('push-new',{text:'Synthetic Gmail push message'});gmailChanged=true;
 ms.add({conversationId:'push-outlook',body:'Synthetic Outlook push message'});
 await f.post('gmail',f.google('11'));await f.post('outlook',f.graph());await f.push.drain();
 const bodies=f.db.prepare('SELECT body FROM messages ORDER BY body').all().map(r=>r.body).join(' ');
 assert.match(bodies,/Synthetic Gmail push message/);assert.match(bodies,/Synthetic Outlook push message/);
 assert.equal(g.sent.length,0);assert.equal(ms.sent.length,0);
});


test('Outlook reconnect replaces only its obsolete callback subscription before duplicate-conflicting POST',async t=>{
 const f=await fixture(t);await f.start();const old=f.lease('outlook').clientState;
 const id=f.accounts.outlook.id,cred=f.vault.open(id,f.store.getSecret(id));delete cred.mailPush;f.store.putSecret(id,f.vault.seal(id,cred));
 const unrelated={id:'unrelated',resource:'me/calendar/events',notificationUrl:'https://other.example.test/hook',clientState:'other',expirationDateTime:new Date(Date.now()+DAY).toISOString()};f.subscriptions.push(unrelated);
 f.push.tick();await f.push.drain();f.push.tick();await f.push.drain();
 assert.equal(f.lease('outlook').status,'active');assert.notEqual(f.lease('outlook').clientState,old);
 assert.ok(f.calls.outlook.some(c=>c.method==='DELETE'&&c.path==='subscriptions/subscription-1'));
 assert.ok(f.subscriptions.includes(unrelated));assert.equal(f.subscriptions.filter(s=>s.resource==='me/messages').length,1);
});


test('same Outlook mailbox in two profiles shares its authenticated Graph subscription',async t=>{
 const f=await fixture(t);await f.start();const first=f.lease('outlook'),otherProfile=f.store.snapshot().profiles.find(p=>p.id!=='perso').id;
 const duplicate=f.store.upsertAccount(otherProfile,{name:'Outlook duplicate',channel:'email',svc:'outlook',address:f.accounts.outlook.address});
 f.store.putSecret(duplicate.id,f.vault.seal(duplicate.id,{refreshToken:'fake-refresh',email:duplicate.address,oauthBinding:'outlook-binding',scopes:[]}));
 f.store.setAccountStatus(duplicate.id,'Connecté','ok');f.push.tick();await f.push.drain();f.push.tick();await f.push.drain();
 const second=()=>f.vault.open(duplicate.id,f.store.getSecret(duplicate.id)).mailPush;
 assert.equal(second().clientState,first.clientState);assert.equal(second().subscriptionId,first.subscriptionId);
 assert.equal(f.subscriptions.length,1);assert.ok(!f.calls.outlook.some(c=>c.method==='DELETE'));
 const before=f.notified.outlook;await f.post('outlook',f.graph());await f.push.drain();
 assert.equal(f.notified.outlook,before+2);assert.equal(second().processed,second().revision);assert.equal(f.lease('outlook').processed,f.lease('outlook').revision);
});
