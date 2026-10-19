import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/runtime/config.js';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createVault} from '../src/secrets.js';
import {createGmailSync} from '../src/providers/gmail/sync.js';
import {createOutlookSync} from '../src/providers/outlook/sync.js';
import {createGmailClient} from '../src/providers/gmail/api.js';
import {createGraphClient} from '../src/providers/outlook/api.js';
import {fakeGoogle} from './helpers/fake-google.js';
import {fakeMicrosoft,ALL_SCOPES} from './outlook-helpers.js';

const scopes=['https://www.googleapis.com/auth/gmail.readonly'];
const hosted={RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',RELAY_SECRET_KEY:'aa'.repeat(32),AUTH_ISSUER:'https://identity.example.test/realms/test',AUTH_CLIENT_ID:'owner-client',AUTH_CLIENT_SECRET:'owner-secret-fake',AUTH_OWNER_SUB:'owner-fake',AUTH_MFA_ACR:'relay-mfa'};
test('configuration OAuth : bureau conservé, Web imposé en hébergé, secrets Web distincts et fichiers',t=>{
 const local=readConfig({});assert.equal(local.mailOAuthMode,'desktop');assert.equal(local.microsoftRedirectUri,'http://localhost:4310/oauth/microsoft/callback');
 const c=readConfig({...hosted,GOOGLE_CLIENT_ID:'desktop-only',MICROSOFT_CLIENT_ID:'desktop-only'});assert.equal(c.mailOAuthMode,'web');assert.equal(c.secrets.GOOGLE_WEB_CLIENT_ID,'');assert.equal(c.googleRedirectUri,'https://relay.example.test/oauth/google/callback');assert.equal(c.microsoftRedirectUri,'https://relay.example.test/oauth/microsoft/callback');
 for(const patch of [{MAIL_OAUTH_MODE:'desktop'},{MAIL_OAUTH_MODE:'spa'},{GOOGLE_WEB_CLIENT_ID:'web'},{MICROSOFT_WEB_CLIENT_SECRET:'fake-only'}])assert.throws(()=>readConfig({...hosted,...patch}),e=>e.code==='configuration_invalid');
 assert.throws(()=>readConfig({MAIL_OAUTH_MODE:'web',PUBLIC_BASE_URL:'http://localhost:4311'}),e=>e.code==='configuration_invalid');
 const dir=mkdtempSync(join(tmpdir(),'relay-web-config-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(join(dir,'id'),'web-client');writeFileSync(join(dir,'secret'),'web-secret-fake');
 const web=readConfig({...hosted,MICROSOFT_WEB_CLIENT_ID_FILE:'id',MICROSOFT_WEB_CLIENT_SECRET_FILE:'secret'},{cwd:dir});assert.equal(web.secrets.MICROSOFT_WEB_CLIENT_ID,'web-client');assert.equal(web.secrets.MICROSOFT_WEB_CLIENT_SECRET,'web-secret-fake');
});

function context(service,path=':memory:') {
 const db=openDatabase(path);seedIfEmpty(db);const store=createStore(db),vault=createVault(Buffer.alloc(32,21));
 const backend=service==='gmail'?fakeGoogle():fakeMicrosoft();const email=service==='gmail'?'jh@gmail.com':'jh@outlook.fr';
 const factory=service==='gmail'?createGmailSync:createOutlookSync;
 let refreshes=0;const oauth=(mode,binding)=>({mode,binding,async refresh(){refreshes++;return{access_token:'at-test',expires_in:3600};}});
 const make=(mode,binding,fetchImpl=backend.fetch)=>factory({store,vault,oauth:oauth(mode,binding),fetchImpl,log:{}});
 const input={profileId:'perso',name:'Boîte fictive',windowDays:7,email,refreshToken:'fake-refresh',scopes:service==='gmail'?scopes:ALL_SCOPES.split(' ')};
 return{db,store,vault,backend,email,make,input,get refreshes(){return refreshes;}};
}

for(const service of ['gmail','outlook']) {
 test(`${service} : jeton bureau/ancien client refusé avant refresh ; reconnexion Web conserve identité, brouillon et mémoire`,async t=>{
  const c=context(service);t.after(()=>c.db.close());const desktop=c.make('desktop','desktop-binding'),initial=desktop.connect(c.input);await initial.ready;await initial.job;
  const account=initial.account,id=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id IS NOT NULL').get(account.id)?.id;
  // Le faux Graph a une conversation ajoutée explicitement si sa boîte initiale est vide.
  if(!id && service==='outlook'){c.backend.add({});await desktop.syncNow(account.id);}
  const mid=id || c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id IS NOT NULL').get(account.id).id;
  c.store.saveDraft(mid,'Brouillon à conserver');c.store.rememberReply(mid,'Texte envoyé entièrement fictif');const memory=c.store.getReplyMemory(mid,{internal:true}),identity=c.store.accountIdentity(account.id);
  desktop.stop();await desktop.drain();
  const web=c.make('web','web-binding'),before=c.refreshes;
  assert.deepEqual(web.permissions(account.id),[]);await web.syncNow(account.id);assert.equal(c.refreshes,before);assert.equal(c.store.getAccount(account.id).status,'À reconnecter');
  await assert.rejects(web.exclusive(account.id,()=>{}),e=>e.code==='oauth_client_changed');
  const next=web.connect({...c.input,refreshToken:'new-web-refresh',expectedAccount:{id:account.id,identity,generation:web.generation(account.id)}});await next.ready;await next.job;
  assert.equal(next.account.id,account.id);assert.equal(c.store.accountIdentity(account.id),identity);assert.equal(c.store.getMessage(mid).draft.text,'Brouillon à conserver');assert.equal(c.store.getReplyMemory(mid,{internal:true}).identity,memory.identity);assert.equal(c.store.getReplyMemory(mid).sampleCount,1);
  assert.equal(c.vault.open(account.id,c.store.getSecret(account.id)).oauthBinding,'web-binding');assert.equal(c.store.accountsBySvc(service).filter(x=>c.store.getAccount(x).name===c.input.name).length,1);
  assert.throws(()=>web.connect({...c.input,name:'Doublon',expectNew:true}),e=>e.code==='duplicate_mailbox');
  assert.throws(()=>web.connect({...c.input,email:'other@example.test',expectedAccount:{id:account.id,identity,generation:web.generation(account.id)}}),e=>e.status===409);
  assert.throws(()=>web.connect({...c.input,expectNew:true}),e=>e.code==='account_changed');
  web.stop();await web.drain();
 });

 test(`${service} : connexion en attente revalide session et identité, aucun secret ancien appliqué au compte recyclé`,async t=>{
  const c=context(service);t.after(()=>c.db.close());const sync=c.make('web','web'),first=sync.connect(c.input);await first.job;
  let release;const blocker=sync.queue(first.account.id,()=>new Promise(r=>{release=r;}));await new Promise(setImmediate);
  let allowed=true;const before=c.store.getSecret(first.account.id),pending=sync.connect({...c.input,refreshToken:'must-not-save',authorize(){if(!allowed)throw Object.assign(new Error('Session révoquée'),{status:401});}});
  allowed=false;release();await blocker;await assert.rejects(pending.ready,e=>e.status===401);await pending.job;assert.deepEqual(c.store.getSecret(first.account.id),before);
  const oldIdentity=c.store.accountIdentity(first.account.id);const target={id:first.account.id,identity:oldIdentity,generation:sync.generation(first.account.id)};
  await sync.forget(first.account.id,()=>c.store.deleteAccount(first.account.id));const replacement=c.store.upsertAccount('perso',{name:c.input.name,svc:service,channel:'email',address:c.email});assert.equal(replacement.id,first.account.id);assert.notEqual(c.store.accountIdentity(replacement.id),oldIdentity);
  assert.throws(()=>sync.connect({...c.input,expectedAccount:target}),e=>e.code==='account_changed');assert.equal(c.store.getSecret(replacement.id),null);
  sync.stop();await sync.drain();
 });

 test(`${service} : ancien secret non étiqueté admis seulement au bureau, changement de client Web fermé`,async t=>{
  const c=context(service);t.after(()=>c.db.close());const account=c.store.upsertAccount('perso',{name:c.input.name,svc:service,channel:'email',address:c.email});
  c.store.putSecret(account.id,c.vault.seal(account.id,{refreshToken:'legacy',email:c.email,scopes:c.input.scopes}));
  const desktop=c.make('desktop','desktop'),web=c.make('web','web');assert.ok(desktop.permissions(account.id).includes('read'));assert.deepEqual(web.permissions(account.id),[]);await assert.rejects(web.exclusive(account.id,()=>{}),e=>e.code==='oauth_client_changed');assert.equal(c.refreshes,0);
  c.store.putSecret(account.id,c.vault.seal(account.id,{refreshToken:'other-client',email:c.email,scopes:c.input.scopes,oauthBinding:'another-web-client'}));assert.deepEqual(web.permissions(account.id),[]);assert.equal(c.refreshes,0);
 });
}

test('clients API : un refresh concurrent unique et rotation persistée avant l’accès, Gmail et Graph',async()=>{
 for(const factory of [createGmailClient,createGraphClient]){
  let refreshes=0,persisted=false;const rotated=[];
  const client=factory({refreshToken:'rt-old',oauth:{async refresh(rt){refreshes++;assert.equal(rt,'rt-old');await new Promise(setImmediate);return{access_token:'fake-at',refresh_token:'rt-new',expires_in:3600};}},onRotate:async rt=>{await new Promise(setImmediate);rotated.push(rt);persisted=true;},fetchImpl:async()=>{assert.equal(persisted,true);return new Response('{}');}});
  await Promise.all([factory===createGmailClient?client.profile():client.me(),factory===createGmailClient?client.profile():client.me()]);assert.equal(refreshes,1);assert.deepEqual(rotated,['rt-new']);
 }
});
