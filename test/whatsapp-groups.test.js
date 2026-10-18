import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupWhatsApp, linkedAccount, msg, tick } from './whatsapp-helpers.js';
import { parseMessage,chatJid,directJid } from '../src/providers/whatsapp/parse.js';

test('groupes WhatsApp : texte, auteurs distincts, brouillons locaux et aucun envoi groupe',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close()});
 const group='120363123456@g.us',since=Date.now()-7*86400000;
 assert.equal(chatJid(group),group);assert.equal(directJid(group),null);
 for(const id of ['status@broadcast','x@g.us','123@newsletter','123-@g.us'])assert.equal(chatJid(id),null);
 const received=msg('g1','Bonjour groupe',{chat:group,pushName:'Alice',extra:{}});received.key.participant='33611111111@s.whatsapp.net';
 const parsed=parseMessage(received,{since});assert.equal(parsed.senderName,'Alice');assert.equal(parsed.participantJid,received.key.participant);
 const next=msg('g2','Autre auteur',{chat:group,pushName:'Bob',ago:60});next.key.participant='33622222222@s.whatsapp.net';
 const {accountId}=await linkedAccount(c,{messages:[received,next]});
 const id=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(accountId,group).id;
 const full=c.store.getMessage(id);assert.equal(full.group,true);assert.equal(full.from,'Bob');assert.equal(full.trail[0].from,'Alice');assert.equal(full.fromMe,false);
 assert.equal(full.subject,'WhatsApp · Groupe WhatsApp','le nom du participant ne devient pas le titre du groupe');
 await c.wa.outbox.saveDraft(id,{text:'Proposition locale',mode:'reply'});
 await assert.rejects(c.wa.outbox.preview(id,{text:'Ne pas envoyer',mode:'reply'}),e=>e.code==='compose_unavailable');
 assert.equal(c.sockets.last().sent.length,0);
 c.sockets.last().emit('chats.update',[{id:group,ephemeralExpiration:86400}]);
 assert.equal(c.store.countThreads(accountId).threads,0,'politique éphémère de groupe purgée');
 assert.ok(c.store.waEphemeralChats(accountId).includes(group),'politique groupe persistée');
 const ephemeral={...received,key:{...received.key,id:'e'},message:{ephemeralMessage:{message:{conversation:'Privé'}}}};
 assert.equal(parseMessage(ephemeral,{since}),null);
});

// Les lots historiques omettent souvent pushName : résoudre le participant dans le carnet du même compte.
test('historique de groupe : noms des auteurs résolus depuis les contacts reçus', async () => {
 const ctx=await setupWhatsApp(); const {accountId,sock}=await linkedAccount(ctx,{messages:[]});
 const group='120363000123456@g.us', author='123456789012345@lid';
 const m=msg('named','Texte',{chat:group,pushName:'',ago:60});m.key.participant=author;
 sock.emit('messaging-history.set',{contacts:[{id:author,name:'Camille'}],chats:[{id:group,name:'Équipe'}],messages:[m]});await tick();
 assert.equal(ctx.store.waChatMessages(accountId,group)[0].senderName,'Camille');
 const row=ctx.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(accountId,group);
 assert.equal(ctx.store.getMessage(row.id).from,'Camille');
 ctx.store.waSetChatName(accountId,author,'Camille Martin');
 assert.equal(ctx.store.getMessage(row.id).from,'Camille Martin','les noms reçus après le lot restent visibles');
 ctx.wa.sync.stop();
});
