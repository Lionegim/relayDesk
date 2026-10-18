import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,connected} from './helpers/fake-google.js';
import {GMAIL_SCOPES} from '../src/providers/gmail/oauth.js';
import {createGmailOutbox} from '../src/providers/gmail/outbox.js';
import {createMailService} from '../src/mail/service.js';
import {draftPrompt} from '../src/ai/assistant.js';
const input={mode:'new',to:'Moi <jh@gmail.com>',cc:'copie@example.test',subject:'Essai indépendant é',text:'Bonjour,\nNouveau message de test.'};
async function ready(scopes=Object.values(GMAIL_SCOPES)) {
 const c=setup();const account=await connected(c,scopes);
 const outbox=createGmailOutbox({...c,ownerName:'Jean-Hugues'});
 const mail=createMailService({store:c.store,providers:{gmail:{sync:c.sync,outbox}}});
 return {...c,account,outbox,mail};
}
test('nouveau message : brouillon Gmail sans fil reçu, mise à jour, aperçu exact puis envoi',async()=>{
 const {store,g,mail,account}=await ready();
 const m=mail.createComposition(account.id);assert.equal(m.kind,'new');assert.equal(store.composeContext(m.id).threadId,null);
 await mail.saveDraft(m.id,input);assert.equal(g.drafts.d1.threadId,undefined);
 const full=store.getMessage(m.id);assert.equal(full.draft.mode,'new');assert.equal(full.draft.cc,input.cc);assert.equal(full.subject,input.subject);
 await mail.saveDraft(m.id,{...input,text:'Version à valider'});assert.equal(Object.keys(g.drafts).length,1);
 const p=await mail.preview(m.id,input);assert.equal(p.subject,input.subject);assert.deepEqual(p.cc,[input.cc]);assert.equal(p.body,input.text);assert.equal(g.sent.length,0);
 for(const change of [{text:'altéré'},{to:'autre@example.test'},{cc:'autre@example.test'},{subject:'altéré'}]) await assert.rejects(mail.send(m.id,{...input,...change,digest:p.digest}),e=>e.status===409);
 await mail.send(m.id,{...input,digest:p.digest});assert.equal(g.sent.length,1);assert.equal(g.sent[0].threadId,undefined);
 assert.doesNotMatch(Buffer.from(g.sent[0].raw,'base64url').toString(),/In-Reply-To:|References:/);
 assert.throws(()=>store.getMessage(m.id),e=>e.status===404);assert.ok(g.drafts.d1,'brouillon fournisseur conservé');
 await assert.rejects(async()=>mail.send(m.id,{...input,digest:p.digest}));assert.equal(g.sent.length,1);
});
test('nouveau message : validation avant réseau, mode isolé des réponses',async()=>{
 const {g,mail,account,store}=await ready();const m=mail.createComposition(account.id);g.calls.length=0;
 for(const bad of [{subject:'Objet\r\nBcc: caché@example.test'},{cc:'x@example.test\nY'},{mode:'reply'}]) await assert.rejects(mail.saveDraft(m.id,{...input,...bad}),e=>e.status===400);
 assert.equal(g.calls.length,0);
 const received=store.snapshot().messages.find(x=>x.kind!=='new' && x.accountId===account.id);await assert.rejects(mail.preview(received.id,input),e=>e.status===400);
});
test('nouveau message : permissions minimales, enregistrement local sans destinataire',async()=>{
 const {mail,store,account,g}=await ready([GMAIL_SCOPES.read]);const m=mail.createComposition(account.id);g.calls.length=0;
 const d=await mail.saveDraft(m.id,{...input,to:''});assert.equal(d.synced,false);assert.equal(store.getMessage(m.id).draft.text,input.text);
 await assert.rejects(mail.preview(m.id,input),e=>e.status===403);assert.equal(g.calls.length,0);
});
test('registre multi-fournisseurs : aucun appel Gmail pour un autre service',async()=>{
 const {store,mail,account,g}=await ready();const other=store.connectAccount('perso',{name:'Microsoft test',svc:'outlook'});
 assert.throws(()=>mail.createComposition(other.id),e=>e.status===503);assert.equal(mail.permissions(other).length,0);
 assert.throws(()=>mail.createComposition('1'),e=>e.status===400);
 const m=mail.createComposition(account.id);await mail.saveDraft(m.id,input);
 const prompts=draftPrompt(store.getMessage(m.id),'Moi',{tone:'Cordial',intent:'Rends plus bref'});
 assert.match(prompts[1].content,/nouveau message/);assert.match(prompts[1].content,/Nouveau message de test/);
});
