import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupWhatsApp,linkedAccount,pairAndOpen,tick } from './whatsapp-helpers.js';

test('reliaison avec historique : même compte, données locales conservées, validation ancienne invalidée et profil persistant',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close()});
 const {accountId,sock}=await linkedAccount(c);
 const id=c.db.prepare('SELECT id FROM messages WHERE account_id=?').get(accountId).id;
 c.wa.sync.updateMessage(id,{flagged:true});
 await c.wa.outbox.saveDraft(id,{text:'Brouillon conservé',mode:'reply'});
 const preview=await c.wa.outbox.preview(id,{text:'Brouillon conservé',mode:'reply'});
 await assert.rejects(c.wa.relink({profileId:'anove',name:'WhatsApp perso',accountId}),e=>e.status===400);
 assert.equal(sock.loggedOut,false);
 const link=await c.wa.relink({profileId:'perso',name:'WhatsApp perso',accountId,windowDays:7});await tick();
 assert.equal(link.accountId,accountId);assert.equal(sock.loggedOut,true);
 assert.equal(c.store.getMessage(id).flagged,true);assert.equal(c.store.getMessage(id).draft.text,'Brouillon conservé');
 assert.equal(c.sockets.last().historyProfile,'desktop-full');
 await pairAndOpen(c);assert.equal(c.sockets.last().historyProfile,'desktop-full');
 await assert.rejects(c.wa.outbox.send(id,{text:'Brouillon conservé',mode:'reply',digest:preview.digest}),e=>e.status===409);
 assert.equal(c.sockets.last().sent.length,0);
 c.wa.sync.stop();await c.wa.sync.start();await tick();
 assert.equal(c.sockets.last().historyProfile,'desktop-full','même profil après redémarrage de la session');
});

test('reliaison tardive : un compte remplacé ne perd jamais sa nouvelle authentification',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close()});const {accountId,sock}=await linkedAccount(c);
 let release;sock.logout=()=>new Promise(r=>{release=r});
 const old=c.wa.relink({profileId:'perso',name:'WhatsApp perso',accountId});await tick();
 c.store.deleteAccount(accountId);
 const next=await c.wa.startLink({profileId:'anove',name:'Nouveau téléphone',windowDays:7});await tick();assert.equal(next.accountId,accountId);
 await pairAndOpen(c);release();await assert.rejects(old,e=>e.code==='account_changed');
 assert.equal(c.store.getAccount(accountId).profileId,'anove');assert.ok(c.store.waAuthGet(accountId,'creds',''));
 assert.equal(c.store.getAccount(accountId).status,'Connecté');
});


test('arrêt : vérification détachée du registre des sessions reste drainée',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});
 await c.wa.startLink({profileId:'perso',name:'Identité fictive',windowDays:7});await tick();
 const sock=c.sockets.last();let release;sock.logout=()=>new Promise(r=>{release=r;});
 sock.emit('connection.update',{connection:'open'});await tick();assert.equal(typeof release,'function');
 c.wa.sync.pause();let done=false;const draining=c.wa.sync.drain().then(()=>{done=true;});await tick();assert.equal(done,false);assert.equal(sock.ended,false);
 release();await draining;c.wa.sync.stop();await c.wa.sync.drain();assert.equal(sock.ended,true);
});
