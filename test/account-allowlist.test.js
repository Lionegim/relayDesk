import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAllowedAccounts,accountPolicy} from '../src/providers/account-policy.js';
import {readConfig} from '../src/runtime/config.js';
import {prepareMailConnection} from '../src/providers/mail-credentials.js';
import {createGmailSync} from '../src/providers/gmail/sync.js';
import {createOutlookSync} from '../src/providers/outlook/sync.js';
import {ME,PEER,msg,closed,tick,until,setupWhatsApp,pairAndOpen,linkedAccount} from './whatsapp-helpers.js';

const entries=parseAllowedAccounts(`gmail:owner@example.test,outlook:work@example.test,whatsapp:+${ME}`);
const policy=accountPolicy(entries);
test('comptes autorisés : identités exactes, casse email, fournisseur et format international',()=>{
 assert.deepEqual(parseAllowedAccounts(' gmail:OWNER@example.test,gmail:owner@example.test '),['gmail:owner@example.test']);
 policy('gmail','OWNER@example.test');policy('outlook','work@example.test');policy('whatsapp',`+${ME}`);
 for(const [svc,address] of [['gmail','work@example.test'],['gmail','owner+alias@example.test'],['whatsapp',ME],['whatsapp','+33100000000']]) assert.throws(()=>policy(svc,address),e=>e.code==='account_not_allowed' && !e.message.includes(address));
 for(const input of [' ','gmail:*@example.test','gmail:x@example.test,','other:x@example.test','whatsapp:0612345678','whatsapp:+0012345678','gmail:x@example.test\noutlook:y@example.test']) assert.throws(()=>parseAllowedAccounts(input));
 assert.throws(()=>accountPolicy(null,{required:true}));assert.doesNotThrow(()=>accountPolicy(null)('gmail','local@example.test'));
});
test('hébergé : configuration refuse les connecteurs sans comptes explicites ; test désactivé et Mac conservés',()=>{
 const env={RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',RELAY_SECRET_KEY:'12'.repeat(32),AUTH_ISSUER:'https://id.example.test/realms/relay',AUTH_CLIENT_ID:'test',AUTH_CLIENT_SECRET:'synthetic',AUTH_OWNER_SUB:'test-owner',AUTH_MFA_ACR:'relay-mfa'};
 assert.throws(()=>readConfig(env),/RELAY_ALLOWED_ACCOUNTS/);
 assert.deepEqual(readConfig({...env,RELAY_ALLOWED_ACCOUNTS:'gmail:owner@example.test'}).allowedAccounts,['gmail:owner@example.test']);
 assert.equal(readConfig({...env,RELAY_CONNECTORS_ENABLED:'false'}).allowedAccounts,null);
 assert.equal(readConfig({}).allowedAccounts,null);
});
for(const service of ['gmail','outlook']) test(`${service} : refus avant création du compte ou écriture de jetons`,()=>{
 let touched=false;
 const store=new Proxy({},{get(){touched=true;throw new Error('stockage ne doit pas être appelé');}});
 assert.throws(()=>prepareMailConnection({store,oauth:{mode:'web'},service,profileId:'perso',name:'Test',email:'wrong@example.test',assertAccountAllowed:policy,generation:()=>0}),e=>e.code==='account_not_allowed');
 assert.equal(touched,false);
});
for(const [service,createSync] of [['gmail',createGmailSync],['outlook',createOutlookSync]]) test(`${service} : compte enregistré désormais interdit, aucun refresh ni envoi réseau`,async()=>{
 let touched=false;
 const sync=createSync({store:{getAccount:()=>({address:'wrong@example.test'})},vault:{open(){touched=true;}},oauth:{},assertAccountAllowed:policy,fetchImpl(){touched=true;throw new Error('réseau interdit');}});
 await assert.rejects(()=>sync.exclusive(1,()=>{touched=true;}),e=>e.code==='account_not_allowed');assert.equal(touched,false);
});
test('WhatsApp : mauvais téléphone délié, secrets purgés, aucun historique importé',async t=>{
 const ctx=await setupWhatsApp({assertAccountAllowed:policy});t.after(async()=>{await ctx.wa.sync.stop();ctx.db.close();});
 const {linkId,accountId}=await ctx.wa.startLink({profileId:'perso',name:'Test',windowDays:7});await tick();
 let imports=0;
 for(const method of ['waAddMessages','upsertThread','upsertAccountContact','waSetChatName']) {
  const original=ctx.store[method];ctx.store[method]=(...args)=>{imports++;return original(...args);};
 }
 const first=ctx.sockets.last();first.auth.state.creds.me={id:'33100000000:7@s.whatsapp.net'};
 first.emit('creds.update',{});first.emit('connection.update',closed(515));await tick();
 const sock=ctx.sockets.last(),history={chats:[{id:PEER}],contacts:[{id:PEER,name:'Fiction'}],messages:[msg('BEFORE','Texte fictif')],isLatest:true};
 sock.emit('messaging-history.set',history);sock.emit('messages.upsert',{type:'notify',messages:[msg('PENDING','Texte fictif')]});
 sock.user={id:'33100000000:7@s.whatsapp.net'};sock.emit('connection.update',{connection:'open'});
 await until(()=>ctx.wa.linkStatus(linkId).status==='error');
 sock.emit('messaging-history.set',history);sock.emit('messages.upsert',{type:'notify',messages:[msg('AFTER','Texte fictif')]});await tick();
 assert.equal(imports,0,'aucune écriture transitoire avant suppression du compte');
 assert.equal(sock.loggedOut,true);assert.equal(ctx.store.hasAccount(accountId),false);
 assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM whatsapp_auth WHERE account_id=?').get(accountId).n,0);
 assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM messages WHERE account_id=?').get(accountId).n,0);
 assert.equal(sock.sent.length,0);
});
test('WhatsApp : téléphone autorisé accepté sans envoi de message',async t=>{
 const ctx=await setupWhatsApp({assertAccountAllowed:policy});t.after(async()=>{await ctx.wa.sync.stop();ctx.db.close();});
 const {accountId}=await ctx.wa.startLink({profileId:'perso',name:'Test',windowDays:7});await tick();const sock=await pairAndOpen(ctx);
 assert.equal(ctx.store.getAccount(accountId).address,`+${ME}`);assert.equal(sock.sent.length,0);
});
test('WhatsApp : reconnexion interdite bloquée avant création du socket',async t=>{
 const ctx=await setupWhatsApp({assertAccountAllowed:policy});t.after(async()=>{await ctx.wa.sync.stop();ctx.db.close();});
 const account=ctx.store.upsertAccount('perso',{name:'Interdit',svc:'whatsapp',channel:'whatsapp',address:'+33100000000'});
 const {linkId}=await ctx.wa.startLink({accountId:account.id,profileId:'perso',name:'Interdit',windowDays:7});
 await until(()=>ctx.wa.linkStatus(linkId).status==='error');assert.equal(ctx.sockets.list.length,0);
 assert.match(ctx.wa.linkStatus(linkId).error,/autorisés/);
});

test('WhatsApp : redémarrage avec session désormais interdite, aucun socket repris',async t=>{
 const first=await setupWhatsApp();await linkedAccount(first);await first.wa.sync.stop();
 const next=await setupWhatsApp({db:first.db,vault:first.vault,assertAccountAllowed:accountPolicy(['gmail:owner@example.test'])});
 t.after(async()=>{await next.wa.sync.stop();next.db.close();});
 await next.wa.sync.start();await tick();await next.wa.sync.drain();
 assert.equal(next.sockets.list.length,0);
 const id=next.store.accountsBySvc('whatsapp').find(id=>next.store.getAccount(id).address===`+${ME}`);
 assert.equal(next.store.getAccount(id).status,'À reconnecter');
 assert.match(next.store.getSync(id).error,/autorisés/);
});
