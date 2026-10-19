import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupWhatsApp,tick,pairAndOpen,ME} from './whatsapp-helpers.js';

const input={profileId:'perso',name:'Compte test',windowDays:7};
async function setup(t,extra={}) {const c=await setupWhatsApp({requireLinkedIdentity:true,...extra});t.after(async()=>{await c.wa.sync.stop();c.db.close();});return c;}
test('enrôlement hébergé : QR sans numéro, identité issue du téléphone après scan',async t=>{
 const c=await setup(t);const {accountId}=await c.wa.startLink(input);await tick();
 assert.equal(c.store.getAccount(accountId).address,null);
 await pairAndOpen(c);assert.equal(c.store.getAccount(accountId).address,`+${ME}`);
});
test('enrôlement : plusieurs numéros autorisés par écran, sans liste de numéros côté serveur',async t=>{
 const c=await setup(t);
 for(const [i,phone] of [ME,'33100000000'].entries()) {
  const {accountId}=await c.wa.startLink({...input,name:`Compte ${i}`});await tick();
  await pairAndOpen(c,{phone});assert.equal(c.store.getAccount(accountId).address,`+${phone}`);
 }
 assert.equal(c.store.accountsBySvc('whatsapp').filter(id=>c.store.getAccount(id).address).length,2);
});
test('enrôlement : le téléphone scanné doit correspondre au numéro confirmé',async t=>{
 const c=await setup(t);const {linkId,accountId}=await c.wa.startLink({...input,expectedPhone:`+${ME}`});await tick();
 const sock=await pairAndOpen(c,{phone:'33100000000'});await tick();
 assert.equal(c.wa.linkStatus(linkId).status,'error');assert.equal(sock.loggedOut,true);assert.equal(c.store.hasAccount(accountId),false);
});
test('reconnexion : changement de numéro refusé avant effacement des clés ou déconnexion',async t=>{
 const c=await setup(t);const {accountId}=await c.wa.startLink({...input,expectedPhone:`+${ME}`});await tick();const sock=await pairAndOpen(c);
 const before=c.db.prepare('select count(*) as n from whatsapp_auth where account_id=?').get(accountId).n;
 await assert.rejects(c.wa.relink({...input,accountId,expectedPhone:'+33100000000'}),e=>e.status===400);
 assert.equal(sock.loggedOut,false);assert.equal(c.db.prepare('select count(*) as n from whatsapp_auth where account_id=?').get(accountId).n,before);
});

test('compte ancien sans numéro : confirmation persistée avant le QR',async t=>{
 const c=await setup(t);const account=c.store.upsertAccount('perso',{name:'Ancien',svc:'whatsapp',channel:'whatsapp'});
 await c.wa.startLink({...input,name:'Ancien',accountId:account.id,expectedPhone:`+${ME}`});
 assert.equal(c.store.getAccount(account.id).address,`+${ME}`);
});
test('reprise héritée sans numéro confirmé : aucun socket ni import',async t=>{
 const first=await setupWhatsApp();const {accountId}=await first.wa.startLink(input);await tick();await pairAndOpen(first);await first.wa.sync.stop();
 first.db.prepare('UPDATE accounts SET address=NULL WHERE id=?').run(accountId);
 const next=await setupWhatsApp({db:first.db,vault:first.vault,requireLinkedIdentity:true});t.after(async()=>{await next.wa.sync.stop();next.db.close();});
 await next.wa.sync.start();await tick();await next.wa.sync.drain();assert.equal(next.sockets.list.length,0);
 assert.equal(next.store.getAccount(accountId).status,'À reconnecter');
});

test('reconnexion QR sans saisie : un autre téléphone ne remplace pas le compte',async t=>{
 const c=await setup(t);const {accountId}=await c.wa.startLink(input);await tick();await pairAndOpen(c);
 const {linkId}=await c.wa.relink({...input,accountId});await tick();const sock=await pairAndOpen(c,{phone:'33100000000'});await tick();
 assert.equal(c.wa.linkStatus(linkId).status,'error');assert.equal(sock.loggedOut,true);assert.equal(c.store.getAccount(accountId).address,`+${ME}`);
});
