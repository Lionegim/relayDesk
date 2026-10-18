import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/runtime/config.js';
import {createRuntime} from '../src/runtime/lifecycle.js';
import {createOwnerAuth} from '../src/auth/index.js';
import {fakeIdp,ISSUER,OWNER,ACR} from './helpers/fake-oidc.js';

test('runtime réel + OIDC signé fictif : deux appareils, redémarrage, aperçu périmé, révocation et déconnexion',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-owner-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const base=`http://127.0.0.1:${port}`,idp=fakeIdp();
 const config=readConfig({DATA_DIR:dir,PORT:String(port),PUBLIC_BASE_URL:base,RELAY_SECRET_KEY:'ab'.repeat(32),DEMO_DATA:'1',RELAY_CONNECTORS_ENABLED:'false',RELAY_AI_ENABLED:'false',AUTH_MODE:'oidc',AUTH_ISSUER:ISSUER,AUTH_CLIENT_ID:'relay-client',AUTH_CLIENT_SECRET:'synthetic-only',AUTH_OWNER_SUB:OWNER,AUTH_MFA_ACR:ACR});
 let fakeAccount,providerSends=0;
 const options={authFactory:({config,db})=>createOwnerAuth({config,db,oidc:{fetch:idp.fetch},log:{warn(){},error(){}}}),providerFactory:({store})=>{
  fakeAccount=store.upsertAccount('perso',{name:'Test OAuth fictif',channel:'email',svc:'gmail',address:'synthetic@example.test'});
  return{syncs:[],providers:{gmail:{sync:{permissions:()=>['read','send']},outbox:{preview:async(_id,input)=>({digest:'c'.repeat(64),body:input.text,to:['synthetic@example.test']}),send:async()=>{providerSends++;return{sent:true};}}}}};
 }};
 let runtime=createRuntime(config,options);await runtime.start();t.after(()=>runtime.stop());
 function device(){
  const jar=new Map();
  const call=async(method,path,body,extra={})=>{
   const res=await fetch(base+path,{method,redirect:'manual',headers:{connection:'close',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),origin:base,...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
   for(const value of res.headers.getSetCookie()){const part=value.split(';')[0],i=part.indexOf('=');if(/Max-Age=0/.test(value))jar.delete(part.slice(0,i));else jar.set(part.slice(0,i),part.slice(i+1));}
   return res;
  };return{call};
 }
 async function login(d){const start=await d.call('GET','/auth/login');assert.equal(start.status,303);const grant=idp.authorize(start.headers.get('location'));const back=await d.call('GET',`/auth/callback?code=${grant.code}&state=${grant.state}`);assert.equal(back.status,303);return(await d.call('GET','/auth/session')).json();}
 const mac=device(),phone=device();assert.equal((await mac.call('GET','/api/state')).status,401);
 const a=await login(mac),b=await login(phone);assert.equal(a.mfa,true);assert.equal((await mac.call('GET','/api/state')).status,200);
 const csrf={'x-csrf-token':a.csrfToken};
 assert.equal((await mac.call('PATCH','/api/messages/1',{flagged:true})).status,403);
 assert.equal((await mac.call('PATCH','/api/messages/1',{flagged:true}, {...csrf,origin:'https://evil.example.test'})).status,403);
 assert.equal((await mac.call('PATCH','/api/messages/1',{flagged:true}, {...csrf,'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await mac.call('PATCH','/api/messages/1',{flagged:true},csrf)).status,200);
 const draft=await(await mac.call('POST','/api/drafts',{accountId:fakeAccount.id},csrf)).json(),input={mode:'new',text:'Uniquement fictif',to:'synthetic@example.test',cc:'',subject:'Test OIDC'};
 const path=`/api/messages/${draft.id}/send`,p=await(await mac.call('POST',path+'/preview',input,csrf)).json();assert.equal(typeof p.approvalToken,'string');
 assert.equal((await phone.call('POST',path,{...input,digest:p.digest,approvalToken:p.approvalToken},{'x-csrf-token':b.csrfToken})).status,409);
 await runtime.stop();runtime=createRuntime(config,options);await runtime.start();
 assert.equal((await mac.call('GET','/api/state')).status,200,'cookie valide après redémarrage, session serveur persistante');
 assert.equal((await mac.call('POST',path,{...input,digest:p.digest,approvalToken:p.approvalToken},csrf)).status,409,'ancien aperçu invalidé après redémarrage');assert.equal(providerSends,0);
 const list=await(await mac.call('GET','/auth/sessions')).json();assert.equal(list.sessions.length,2);
 assert.equal((await mac.call('DELETE',`/auth/sessions/${b.sessionId}`,{},csrf)).status,200);
 assert.equal((await phone.call('GET','/api/state')).status,401);
 assert.equal((await mac.call('POST','/auth/logout',{},csrf)).status,200);assert.equal((await mac.call('GET','/api/state')).status,401);
 await runtime.stop();
});
