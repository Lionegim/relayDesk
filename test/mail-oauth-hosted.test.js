import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request,createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/runtime/config.js';
import {createRuntime} from '../src/runtime/lifecycle.js';
import {assembleProviders} from '../src/runtime/providers.js';
import {createOwnerAuth} from '../src/auth/index.js';
import {createVault} from '../src/secrets.js';
import {fakeIdp,ISSUER,PUBLIC,OWNER,ACR} from './helpers/fake-oidc.js';
import {fakeWebMail} from './helpers/fake-web-mail.js';

async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'relay-web-mail-test-'));const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const idp=fakeIdp(),backend=fakeWebMail(),vault=createVault(Buffer.alloc(32,26));let bundle,runtime;
 const config=readConfig({DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),RELAY_MODE:'hosted',PUBLIC_BASE_URL:PUBLIC,RELAY_SECRET_KEY:Buffer.alloc(32,26).toString('hex'),DEMO_DATA:'1',RELAY_CONNECTORS_ENABLED:'false',RELAY_AI_ENABLED:'false',AUTH_ISSUER:ISSUER,AUTH_CLIENT_ID:'relay-client',AUTH_CLIENT_SECRET:'owner-fake-secret',AUTH_OWNER_SUB:OWNER,AUTH_MFA_ACR:ACR,GOOGLE_CLIENT_ID:'desktop-must-not-use',MICROSOFT_CLIENT_ID:'desktop-must-not-use',GOOGLE_WEB_CLIENT_ID:'google-web-client',GOOGLE_WEB_CLIENT_SECRET:'google-web-secret-fake',MICROSOFT_WEB_CLIENT_ID:'microsoft-web-client',MICROSOFT_WEB_CLIENT_SECRET:'microsoft-web-secret-fake'});
 const options={authFactory:({config,db})=>createOwnerAuth({config,db,oidc:{fetch:idp.fetch},log:{warn(){},error(){}}}),providerFactory:async args=>{
  bundle=await assembleProviders({...args,config:{...args.config,connectorsEnabled:true},fetchImpl:backend.fetch});
  // La recette ne démarre que les adaptateurs de courrier simulés ; aucun socket WhatsApp n'est construit.
  return{gmail:bundle.gmail,providers:{outlook:bundle.providers.outlook},syncs:[bundle.gmail.sync,bundle.providers.outlook.sync]};
 }};
 async function start(){runtime=createRuntime(config,options);await runtime.start();}
 await start();
 t.after(async()=>{await runtime.stop();rmSync(dir,{recursive:true,force:true});});
 const device=(ua)=>{
  const cookies=new Map();let csrf;
  const call=(method,path,body,extra={})=>new Promise((resolve,reject)=>{
   const req=request({host:'127.0.0.1',port,path,method,headers:{host:new URL(PUBLIC).host,origin:PUBLIC,'user-agent':ua,connection:'close',cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(csrf?{'x-csrf-token':csrf}:{}),...(body?{'content-type':'application/json','content-length':Buffer.byteLength(JSON.stringify(body))}:{}),...extra}},res=>{
    for(const value of res.headers['set-cookie'] || []){const pair=value.split(';')[0],i=pair.indexOf('=');if(/Max-Age=0/.test(value))cookies.delete(pair.slice(0,i));else cookies.set(pair.slice(0,i),pair.slice(i+1));}
    let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,data});});
   });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const login=async()=>{const start=await call('GET','/auth/login'),g=idp.authorize(start.headers.location);assert.equal((await call('GET',`/auth/callback?code=${g.code}&state=${g.state}`)).status,303);const session=(await call('GET','/auth/session')).data;csrf=session.csrfToken;return session;};
  return{call,login};
 };
 return{backend,vault,device,get runtime(){return runtime;},get bundle(){return bundle;},async restart(){await runtime.stop();await start();}};
}

test('hébergé simulé : migration bureau → Web, retours HTTPS, profils et données conservés, refresh après redémarrage',async t=>{
 const f=await fixture(t),mac=f.device('Mozilla/5.0 (Mac OS X) Chrome/130'),phone=f.device('Mozilla/5.0 (iPhone) Safari/605');await mac.login();await phone.login();
 const saved=[];
 for(const [provider,svc,name,profile,device,externalId,email] of [['google','gmail','Gmail Web test','perso',mac,'t1','jh@gmail.com'],['microsoft','outlook','Outlook Web test','anove',phone,'C1','jh@outlook.fr']]) {
  const store=f.runtime.store,account=store.upsertAccount(profile,{name,svc,channel:'email',address:email});store.putSecret(account.id,f.vault.seal(account.id,{refreshToken:'legacy-do-not-send',email,scopes:[]}));
  const mid=store.upsertThread(account.id,{...store.getMessage(1),externalId,body:'Conversation entièrement fictive',from:'Contact fictif',trail:[],count:1});store.saveDraft(mid,'Brouillon conservé');store.rememberReply(mid,'Réponse de style fictive');const memory=store.getReplyMemory(mid,{internal:true}).identity,identity=store.accountIdentity(account.id);
  const sync=svc==='gmail'?f.bundle.gmail.sync:f.bundle.providers.outlook.sync;const before=f.backend.tokenCalls.length;await sync.syncNow(account.id);assert.equal(f.backend.tokenCalls.length,before);
  const start=await device.call('POST',`/api/oauth/${provider}/start`,{profile,name,win:7,perms:'read,drafts,send',account:account.id});assert.equal(start.status,200);
  const url=new URL(start.data.url);assert.equal(url.searchParams.get('redirect_uri'),`${PUBLIC}/oauth/${provider}/callback`);assert.equal(url.searchParams.get('client_id'),`${provider}-web-client`);assert.equal(url.searchParams.has('client_secret'),false);
  const grant=f.backend.grant(provider,start.data.url),path=`/oauth/${provider}/callback?state=${grant.state}&code=${grant.code}&profile=wrong-profile`;
  const other=device===mac?phone:mac;assert.equal((await other.call('GET',path)).status,403);const callback=await device.call('GET',path);assert.equal(callback.status,302);assert.equal(new URL(callback.headers.location,PUBLIC).searchParams.get('profile'),profile);assert.equal(new URL(callback.headers.location,PUBLIC).searchParams.get('account'),String(account.id));await sync.drain();
  assert.equal((await device.call('GET',path)).status,403);assert.equal(store.accountIdentity(account.id),identity);assert.equal(store.getMessage(mid).draft.text,'Brouillon conservé');assert.equal(store.getReplyMemory(mid,{internal:true}).identity,memory);assert.equal(store.getReplyMemory(mid).sampleCount,1);
  const credential=f.vault.open(account.id,store.getSecret(account.id));assert.equal(credential.oauthBinding,svc==='gmail'?f.bundle.gmail.oauth.binding:f.bundle.providers.outlook.oauth.binding);saved.push({accountId:account.id,mid,memory,identity,refreshToken:credential.refreshToken});
 }
 const pending=await mac.call('POST','/api/oauth/google/start',{profile:'perso',name:'Pending restart',win:7,perms:'read'});assert.equal(pending.status,200);const stale=f.backend.grant('google',pending.data.url);
 const before=f.backend.tokenCalls.length;await f.restart();await Promise.all([f.bundle.gmail.sync.drain(),f.bundle.providers.outlook.sync.drain()]);assert.equal((await mac.call('GET','/api/state')).status,200);
 assert.ok(f.backend.tokenCalls.length>before,'le redémarrage provoque un refresh avec les secrets Web');
 assert.equal((await mac.call('GET',`/oauth/google/callback?state=${stale.state}&code=${stale.code}`)).status,403,'une connexion en attente doit être recommencée après redémarrage');
 for(const item of saved){assert.equal(f.runtime.store.accountIdentity(item.accountId),item.identity);assert.equal(f.runtime.store.getMessage(item.mid).draft.text,'Brouillon conservé');assert.equal(f.runtime.store.getReplyMemory(item.mid,{internal:true}).identity,item.memory);const secret=f.vault.open(item.accountId,f.runtime.store.getSecret(item.accountId));assert.notEqual(secret.refreshToken,item.refreshToken,'rotation sauvegardée après reprise');}
 assert.equal(f.backend.google.sent.length,0);assert.equal(f.backend.microsoft.sent.length,0);
});

test('retour OAuth Web : identité différente, compte supprimé/recréé et session révoquée pendant échange refusés',async t=>{
 const f=await fixture(t),mac=f.device('Chrome Mac'),phone=f.device('Safari iPhone'),a=await mac.login(),b=await phone.login();
 const name='Gmail protégé',store=f.runtime.store,account=store.upsertAccount('perso',{name,svc:'gmail',channel:'email',address:'jh@gmail.com'});
 const start=()=>mac.call('POST','/api/oauth/google/start',{profile:'perso',name,win:7,perms:'read',account:account.id});
 let response=await start(),grant=f.backend.grant('google',response.data.url,{email:'other@example.test'});let back=await mac.call('GET',`/oauth/google/callback?state=${grant.state}&code=${grant.code}`);assert.ok(new URL(back.headers.location,PUBLIC).searchParams.has('connect_error'));assert.equal(store.getSecret(account.id),null);
 response=await start();grant=f.backend.grant('google',response.data.url);const identity=store.accountIdentity(account.id);await f.bundle.gmail.sync.forget(account.id,()=>store.deleteAccount(account.id));const next=store.upsertAccount('perso',{name,svc:'gmail',channel:'email',address:'jh@gmail.com'});assert.equal(next.id,account.id);assert.notEqual(store.accountIdentity(next.id),identity);const count=f.backend.tokenCalls.length;assert.equal((await mac.call('GET',`/oauth/google/callback?state=${grant.state}&code=${grant.code}`)).status,409);assert.equal(f.backend.tokenCalls.length,count);
 response=await start();grant=f.backend.grant('google',response.data.url);let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);f.backend.beforeToken=async()=>{entered();await gate;};
 const callback=mac.call('GET',`/oauth/google/callback?state=${grant.state}&code=${grant.code}`);await Promise.race([waiting,callback.then(result=>{throw new Error('Retour prématuré : '+result.status+' '+JSON.stringify(result.data));})]);let revocation;try{revocation=await phone.call('DELETE',`/auth/sessions/${a.sessionId}`,{});}finally{release();}assert.equal(revocation.status,200);back=await callback;assert.ok(new URL(back.headers.location,PUBLIC).searchParams.has('connect_error'));assert.equal(store.getSecret(next.id),null);assert.equal((await mac.call('GET','/api/state')).status,401);assert.equal(b.authenticated,true);
});
