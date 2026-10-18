import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as lib from '@whiskeysockets/baileys';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/secrets.js';
import { createWhatsAppProvider } from '../src/providers/whatsapp/index.js';
import { textOf } from '../src/providers/whatsapp/parse.js';
const tick = () => new Promise(r=>setImmediate(r));
const delay = ms => new Promise(r=>setTimeout(r,ms));
const jid = '33612345678@s.whatsapp.net';
const message = (id='m1',text='Bonjour') => ({key:{id,remoteJid:jid,fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:text},pushName:'Contact test'});
async function setup(t) {
 const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});const store=createStore(db),vault=createVault(randomBytes(32)),sockets=[];
 const makeSocket=async({auth})=>{const sock={auth,ev:new EventEmitter(),user:{id:'33600000000:1@s.whatsapp.net'},sent:[],logout:async()=>{},end:()=>{},sendMessage:async(j,body)=>{sock.sent.push({j,body});return {key:{id:'sent1'}}}};sockets.push(sock);return sock};
 const p=await createWhatsAppProvider({store,vault,lib:async()=>lib,makeSocket,log:{},timing:{settleMs:5,retryBaseMs:2,retryMaxMs:10,linkTtlMs:40,retainMs:10000}});
 t.after(()=>{p.sync.stop();db.close()});
 async function link(name='Téléphone',accountId) {const l=await p.startLink({profileId:'perso',name,windowDays:7,...(accountId?{accountId}:{})});await tick();return l}
 async function pair(sock=sockets.at(-1),open=true){sock.auth.state.creds.me={id:sock.user.id};sock.auth.state.creds.registered=true;sock.ev.emit('creds.update',{});if(open)sock.ev.emit('connection.update',{connection:'open'});await tick()}
 return {p,store,db,vault,sockets,link,pair};
}
test('WhatsApp : légendes de médias et enveloppes éphémères exclues',()=>{
 for(const k of ['imageMessage','videoMessage','documentMessage'])assert.equal(textOf({[k]:{caption:'Confidentiel'}}),null);
 assert.equal(textOf({ephemeralMessage:{message:{conversation:'Temporaire'}}}),null);
});
test('WhatsApp : retry après appairage conserve la liaison et son compte au-delà du timeout initial',async t=>{
 const c=await setup(t),l=await c.link();await c.pair(c.sockets[0],false);
 c.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:408}}}});
 await delay(10);assert.equal(c.sockets.length,2);await c.pair();await delay(50);
 assert.equal(c.p.linkStatus(l.linkId).status,'connected');assert.equal(c.store.hasAccount(l.accountId),true);
 assert.ok(c.store.waAuthGet(l.accountId,'creds',''));
});
test('WhatsApp : retry entre vérification et fin import termine aussi la fenêtre de liaison',async t=>{
 const c=await setup(t),l=await c.link();await c.pair();
 c.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:408}}}});
 await delay(10);await c.pair();await delay(10);assert.equal(c.p.linkStatus(l.linkId).status,'connected');
});
test('WhatsApp : politique éphémère persistante, mise à jour tardive purge contenu et contact',async t=>{
 const c=await setup(t),l=await c.link();await c.pair();let sock=c.sockets.at(-1);
 sock.ev.emit('messages.upsert',{type:'notify',messages:[message()]});assert.equal(c.store.countThreads(l.accountId).threads,1);
 sock.ev.emit('chats.update',[{id:jid,ephemeralExpiration:86400}]);
 assert.equal(c.store.countThreads(l.accountId).threads,0);assert.equal(c.store.snapshot().contacts.length,0);
 await c.p.sync.stop();await c.p.sync.start();await tick();sock=c.sockets.at(-1);await c.pair(sock);
 sock.ev.emit('messages.upsert',{type:'notify',messages:[message('m2')]});assert.equal(c.store.countThreads(l.accountId).threads,0);
 sock.ev.emit('chats.update',[{id:jid,ephemeralExpiration:null}]);sock.ev.emit('messages.upsert',{type:'notify',messages:[message('m3')]});assert.equal(c.store.countThreads(l.accountId).threads,1);
});
test('WhatsApp : aperçu ancien invalidé dès remplacement de liaison',async t=>{
 const c=await setup(t),l=await c.link();await c.pair();await delay(8);
 c.sockets.at(-1).ev.emit('messages.upsert',{type:'notify',messages:[message()]});const id=c.store.snapshot().messages[0].id;
 const input={mode:'reply',text:'Réponse validée'},preview=await c.p.outbox.preview(id,input);
 c.sockets.at(-1).ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await c.link('Téléphone',l.accountId);await c.pair();
 await assert.rejects(c.p.outbox.send(id,{...input,digest:preview.digest}),e=>e.status===409);assert.equal(c.sockets.at(-1).sent.length,0);
});
test('WhatsApp : rejet identité tardif ne peut pas effacer les clés d’un compte réutilisant ID',async t=>{
 const c=await setup(t),l=await c.link();let release;
 const sock=c.sockets.at(-1);sock.user.id='not-a-phone@lid';sock.logout=()=>new Promise(r=>{release=r});
 sock.ev.emit('connection.update',{connection:'open'});await tick();
 await c.p.disconnect(l.accountId);const next=await c.link('Nouveau téléphone');assert.equal(next.accountId,l.accountId);
 await c.pair();release();await tick();assert.ok(c.store.waAuthGet(next.accountId,'creds',''));assert.equal(c.store.getAccount(next.accountId).status,'Connecté');
});

test('WhatsApp : journaux libsignal masquent objets de session sans supprimer les diagnostics ordinaires',async()=>{
 const {redactSignalLogs}=await import('../src/providers/whatsapp/redact-signal-logs.js');
 const calls=[],target=Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,(...a)=>calls.push(a)]));
 redactSignalLogs(target);redactSignalLogs(target);
 target.info('Closing session:',{privateKey:'SECRET'});target.warn('Session already closed',{rootKey:'SECRET'});
 target.error('Erreur réseau ordinaire',503);
 assert.equal(JSON.stringify(calls).includes('SECRET'),false);assert.equal(calls.length,3);assert.deepEqual(calls[2],['Erreur réseau ordinaire',503]);
});

test('WhatsApp : brouillon local et envoi exact à usage unique vers discussion stockée',async t=>{
 const c=await setup(t),l=await c.link();await c.pair();await delay(8);const sock=c.sockets.at(-1);
 sock.ev.emit('messages.upsert',{type:'notify',messages:[message()]});const id=c.store.snapshot().messages[0].id;
 const input={mode:'reply',text:'Bonjour, voici le texte exact.','to':'autre@example.test'};
 const draft=await c.p.outbox.saveDraft(id,input);assert.equal(draft.synced,false);assert.equal(sock.sent.length,0);
 const p=await c.p.outbox.preview(id,input);assert.equal(p.body,input.text);assert.equal(p.channel,'whatsapp');assert.equal(sock.sent.length,0);
 await assert.rejects(c.p.outbox.send(id,{...input,text:'Autre contenu',digest:p.digest}),e=>e.status===409);
 await c.p.outbox.send(id,{...input,digest:p.digest});assert.deepEqual(sock.sent,[{j:jid,body:{text:input.text}}]);
 assert.equal(c.store.getMessage(id).draft,null);
 await assert.rejects(c.p.outbox.send(id,{...input,digest:p.digest}),e=>e.status===409);assert.equal(sock.sent.length,1);
 await assert.rejects(c.p.outbox.preview(id,{...input,mode:'forward'}),e=>e.status===400);
 await assert.rejects(c.p.outbox.preview(id,{...input,text:'x'.repeat(4097)}),e=>e.status===400);
});
