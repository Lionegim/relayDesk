import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,connected} from './helpers/fake-google.js';
import {fakeMicrosoft,ALL_SCOPES} from './outlook-helpers.js';
import {createMicrosoftOAuth} from '../src/providers/outlook/oauth.js';
import {createOutlookSync} from '../src/providers/outlook/sync.js';
import {createOutlookOutbox} from '../src/providers/outlook/outbox.js';
import {createOutlookDisconnect} from '../src/providers/outlook/disconnect.js';
import {createGmailOutbox} from '../src/providers/gmail/outbox.js';
import {GMAIL_SCOPES} from '../src/providers/gmail/oauth.js';
import {createMistralClient} from '../src/ai/mistral.js';
import {createApp} from '../src/http/app.js';
test('HTTP : compositeur commun choisit réellement le fournisseur et empêche tout envoi sans aperçu valide',async()=>{
 const ctx=setup();const google=await connected(ctx,Object.values(GMAIL_SCOPES));
 const ms=fakeMicrosoft({scope:ALL_SCOPES});const oauth=createMicrosoftOAuth({clientId:'fake',fetchImpl:ms.fetch});
 const sync=createOutlookSync({...ctx,oauth,fetchImpl:ms.fetch,log:{}});
 const {account,job}=sync.connect({profileId:'perso',name:'Microsoft réel de test',windowDays:7,refreshToken:'fake',email:'jh@outlook.fr',scopes:ALL_SCOPES.split(' ')});await job;
 const providers={gmail:{oauth:ctx.oauth,sync:ctx.sync,outbox:createGmailOutbox(ctx)},outlook:{oauth,sync,outbox:createOutlookOutbox({...ctx,sync}),disconnect:createOutlookDisconnect({store:ctx.store,sync}),redirectUri:'http://localhost:4310/oauth/microsoft/callback'}};
 const server=createApp({store:ctx.store,providers,ai:createMistralClient({apiKey:'',model:'fake'}),ownerName:'Moi'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try {
  const state=await(await fetch(base+'/api/state')).json();assert.equal(state.integrations.outlook.configured,true);
  for(const acc of [account,google]) {
   const made=await call('POST','/api/drafts',{accountId:acc.id});assert.equal(made.status,200);
   const id=made.body.id,input={mode:'new',text:'Message validé',to:acc.address,cc:'',subject:'Essai multi-compte'};
   assert.equal((await call('PUT',`/api/messages/${id}/draft`,input)).body.synced,true);
   assert.equal((await call('POST',`/api/messages/${id}/send`,input)).status,400);
   const p=await call('POST',`/api/messages/${id}/send/preview`,input);assert.match(p.body.from,new RegExp(acc.address.replace(/[.]/g,'\\.')));
   assert.equal((await call('POST',`/api/messages/${id}/send`,{...input,subject:'Non validé',digest:p.body.digest})).status,409);
   assert.equal((await call('POST',`/api/messages/${id}/send`,{...input,digest:p.body.digest})).body.sent,true);
  }
  assert.equal(ms.sent.length,1);assert.equal(ctx.g.sent.length,1);
  const auth=await fetch(base+'/oauth/microsoft/start?profile=perso&name=Autre&win=7&perms=read,send',{redirect:'manual'});
  assert.equal(new URL(auth.headers.get('location')).hostname,'login.microsoftonline.com');
  const refused=await fetch(base+'/oauth/microsoft/callback?error=access_denied',{redirect:'manual'});
  assert.match(new URL(refused.headers.get('location'),base).searchParams.get('connect_error'),/Microsoft/);
 }finally{sync.stop();ctx.sync.stop();await new Promise(r=>server.close(r));ctx.db.close();}
});
