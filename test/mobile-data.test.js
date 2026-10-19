// Pages et éditions multi-appareils sur SQLite et fournisseurs entièrement fictifs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createApp} from '../src/http/app.js';
import {createAssistantService} from '../src/mail/assistant-service.js';
import {setup,connected} from './helpers/fake-google.js';
import {setupOutlook,connectedOutlook,G} from './outlook-helpers.js';
import {createGmailOutbox} from '../src/providers/gmail/outbox.js';
import {createOutlookOutbox} from '../src/providers/outlook/outbox.js';
import {createWhatsAppOutbox} from '../src/providers/whatsapp/outbox.js';
import {GMAIL_SCOPES} from '../src/providers/gmail/oauth.js';

function seeded(t){const db=openDatabase(':memory:');seedIfEmpty(db);t.after(()=>db.close());return createStore(db);}

test('démarrage HTTP : premier profil réel sans Anove, profil explicite invalide toujours refusé', async t => {
 const db=openDatabase(':memory:');t.after(()=>db.close());
 seedIfEmpty(db,{demo:false,seed:{PROFILES:[{id:'perso',name:'Fictional test profile',kind:'Test',initials:'T',accounts:[]}],FOLDERS:[],MESSAGES:[],CONTACTS:[]}});
 const store=createStore(db),server=createApp({store,ai:{configured:false},ownerName:'Test'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const res=await fetch(base+'/api/state?paged=1&limit=50');assert.equal(res.status,200);
 const data=await res.json();assert.equal(data.profiles[0].id,'perso');assert.equal(data.page.total,0);assert.deepEqual(data.messages,[]);
 assert.equal((await fetch(base+'/api/state?paged=1&profile=anove')).status,400);
});
const fill=(store,account,n=125)=>Array.from({length:n},(_,i)=>store.upsertThread(account.id,{...store.getMessage(1),externalId:'page-'+i,sortAt:100000-Math.floor(i/3),subject:'Projet '+i,from:'Contact fictif',trail:[],body:'Texte privé fictif '+i,preview:'Aperçu '+i,unread:i%2===0,flagged:i%3===0,folderId:null,count:1}));

test('pagination SQL : pages stables à date égale, compteurs complets, filtres de profil et recherche',t=>{
 const store=seeded(t),a=store.upsertAccount('perso',{name:'Pagination',channel:'email',svc:'gmail'}),ids=fill(store,a);
 const options={profile:'perso',q:'Projet',limit:17};let cursor=null,seen=[];
 do{const page=store.snapshot({...options,cursor});assert.ok(page.messages.length<=17);assert.equal(page.page.total,125);assert.ok(page.counts.all>=125);assert.equal(page.messages.some(m=>'body' in m),false);seen.push(...page.messages.map(m=>m.id));cursor=page.page.nextCursor;}while(cursor);
 assert.equal(new Set(seen).size,125);assert.equal(seen.length,125);assert.deepEqual(new Set(seen),new Set(ids));
 store.upsertThread(a.id,{...store.getMessage(ids[0]),externalId:'unicode',subject:'ÉTUDE À PARTAGER',sortAt:1,trail:[]});for(const q of ['ÉTUDE','étude'])assert.equal(store.snapshot({profile:'perso',q}).page.total,1);
 const first=store.snapshot(options);assert.throws(()=>store.snapshot({...options,profile:'anove',cursor:first.page.nextCursor}),e=>e.status===400);
 for(const patch of [{limit:0},{limit:101},{cursor:'invalid!'},{nav:'deleted'},{channel:'no'},{q:'x'.repeat(501)},{folder:'f1'}])assert.throws(()=>store.snapshot({...options,...patch}),e=>e.status===400);
 const unread=store.snapshot({...options,nav:'unread',limit:100});assert.equal(unread.page.total,63);assert.ok(unread.messages.every(m=>m.unread));
 const folder=store.createFolder({profileId:'perso',name:'Parent'}),sub=store.createFolder({profileId:'perso',name:'Enfant',parentId:folder.id});store.updateMessage(ids[0],{folderId:sub.id});
 const found=store.snapshot({profile:'perso',folder:folder.id,q:'Projet 0'});assert.equal(found.page.total,1);assert.equal(found.counts.folders[folder.id],1);assert.equal(found.messages[0].id,ids[0]);
});

test('historique borné Gmail et WhatsApp, curseurs périmés refusés, contexte IA complet',async t=>{
 const store=seeded(t),a=store.upsertAccount('perso',{name:'Histoire',channel:'email',svc:'gmail'}),trail=Array.from({length:121},(_,i)=>({from:'Fictif',initials:'F',body:'Ancien '+i,at:10000-i}));
 const id=store.upsertThread(a.id,{...store.getMessage(1),externalId:'history',sortAt:10000,trail,count:122});let next=null,all=[];
 do{const page=store.getMessage(id,{limit:19,before:next});all.push(...page.trail.map(x=>x.body));assert.ok(page.trail.length<=19);next=page.history.nextCursor;}while(next);
 assert.equal(new Set(all).size,121);assert.equal(store.getMessage(id).trail.length,121);
 let captured;const assistant=createAssistantService({store,ai:{model:'fake',complete:async prompt=>{captured=JSON.stringify(prompt);return 'Résumé fictif';}},mail:{},ownerName:'Test'});await assistant.run('summary',id);assert.match(captured,/Ancien 120/);
 const old=store.getMessage(id,{limit:10}).history.nextCursor;store.upsertThread(a.id,{...store.getMessage(id),externalId:'history',sortAt:10001,trail,count:122});assert.throws(()=>store.getMessage(id,{before:old}),e=>e.code==='history_changed');
 const wa=store.upsertAccount('perso',{name:'Chat fictif',channel:'whatsapp',svc:'whatsapp'}),jid='33600000000@s.whatsapp.net';store.waAddMessages(wa.id,Array.from({length:121},(_,i)=>({chatJid:jid,msgId:'m'+i,fromMe:i%2===0,ts:1000+Math.floor(i/3),text:'Bulle '+i})));
 const wid=store.upsertThread(wa.id,{...store.getMessage(1),externalId:jid,body:'Bulle 120',sortAt:1040,trail:[],count:121});all=[];next=null;
 do{const p=store.getMessage(wid,{limit:13,before:next});assert.equal(p.body,'Bulle 120');all.push(...p.trail.map(x=>x.body));assert.ok(p.trail.length<=13);next=p.history.nextCursor;}while(next);
 assert.equal(all.length,120);assert.equal(new Set(all).size,120);assert.equal(store.getMessage(wid).trail.length,120);
});

test('brouillons HTTP : version obligatoire, conflits sans perte et identifiants réutilisés protégés',async t=>{
 const store=seeded(t),server=createApp({store,ai:{configured:false},ownerName:'Test'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const call=async(method,path,body)=>{const res=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{status:res.status,data:await res.json(),headers:res.headers};};
 const version=(await call('GET','/api/messages/1')).data.draftVersion;
 assert.equal((await call('PUT','/api/messages/1/draft',{text:'Sans version'})).status,400);
 const saved=await call('PUT','/api/messages/1/draft',{text:'Version du téléphone',baseVersion:version});assert.equal(saved.status,200);assert.ok(saved.data.version>version);
 const conflict=await call('PUT','/api/messages/1/draft',{text:'Ancien texte du Mac',baseVersion:version});assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'draft_conflict');assert.equal(store.getMessage(1).draft.text,'Version du téléphone');
 store.clearDraft(1);assert.throws(()=>store.assertDraftVersion(1,saved.data.version),e=>e.code==='draft_conflict');
 const a=store.upsertAccount('perso',{name:'Composition test',svc:'gmail',channel:'email'}),first=store.createComposition(a.id);store.clearDraft(first.id);const second=store.createComposition(a.id);assert.equal(second.id,first.id);assert.notEqual(second.draftVersion,first.draftVersion);assert.throws(()=>store.assertDraftVersion(second.id,first.draftVersion),e=>e.code==='draft_conflict');
 const page=await call('GET','/api/state?paged=1&profile=anove&limit=2');assert.equal(page.status,200);assert.equal(page.data.messages.length,2);assert.ok(page.data.page.hasMore);assert.equal(page.headers.get('cache-control'),'no-store');
});

for(const service of ['gmail','outlook'])test(service+' : sauvegardes concurrentes vérifiées dans la file avant tout appel fournisseur, aperçu caduc après édition',async t=>{
 const ctx=service==='gmail'?setup():setupOutlook();t.after(()=>{ctx.sync.stop();ctx.db.close();});
 const account=service==='gmail'?await connected(ctx,Object.values(GMAIL_SCOPES)):await connectedOutlook(ctx,[`${G}Mail.ReadWrite`,`${G}Mail.Send`]);
 const outbox=service==='gmail'?createGmailOutbox(ctx):createOutlookOutbox(ctx),m=ctx.store.createComposition(account.id),input={mode:'new',to:'owner@example.test',cc:'',subject:'Test fictif',text:'Téléphone',baseVersion:m.draftVersion};
 const results=await Promise.allSettled([outbox.saveDraft(m.id,input),outbox.saveDraft(m.id,{...input,text:'Mac'})]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'draft_conflict');assert.equal(ctx.store.getMessage(m.id).draft.text,'Téléphone');
 const calls=service==='gmail'?ctx.g.calls:ctx.ms.calls;assert.equal(calls.filter(c=>c.method==='POST' && (/drafts$/.test(c.path) || /me\/messages$/.test(c.path))).length,1);
 await assert.rejects(outbox.preview(m.id,input),e=>e.code==='draft_conflict');assert.equal(ctx.store.getMessage(m.id).draft.text,'Téléphone');
 const p=await outbox.preview(m.id,{...input,baseVersion:results[0].value.version});await outbox.saveDraft(m.id,{...input,text:'Nouvelle édition',baseVersion:results[0].value.version});await assert.rejects(outbox.send(m.id,{...input,digest:p.digest}),e=>e.code==='draft_conflict');assert.equal(ctx.store.getMessage(m.id).draft.text,'Nouvelle édition');assert.equal((service==='gmail'?ctx.g.sent:ctx.ms.sent).length,0);
});


test('WhatsApp : une version ancienne ne valide ni n’efface le texte récent',async t=>{
 const store=seeded(t),a=store.upsertAccount('perso',{name:'WhatsApp fictif',channel:'whatsapp',svc:'whatsapp'});
 const id=store.upsertThread(a.id,{...store.getMessage(1),externalId:'33600000000@s.whatsapp.net',trail:[],count:1});let sent=0;
 const outbox=createWhatsAppOutbox({store,sync:{onForget(){},isWhatsApp:()=>true,permissions:()=>['read','send'],serial:async(_id,fn)=>fn(),generation:()=>1,liveSocket:()=>({sendMessage:async()=>{sent++;}})}});
 const old=store.getMessage(id).draftVersion,input={text:'Ancien',mode:'reply',baseVersion:old};const preview=await outbox.preview(id,input);
 const current=await outbox.saveDraft(id,{text:'Téléphone récent',mode:'reply',baseVersion:old});assert.ok(current.version>old);
 await assert.rejects(outbox.preview(id,input),e=>e.code==='draft_conflict');await assert.rejects(outbox.send(id,{...input,digest:preview.digest}),e=>e.code==='draft_conflict');assert.equal(store.getMessage(id).draft.text,'Téléphone récent');assert.equal(sent,0);
});

for(const service of ['gmail','outlook'])test(service+' : saisie incomplète du destinataire sauvegardée localement, envoi toujours refusé',async t=>{
 const ctx=service==='gmail'?setup():setupOutlook();t.after(()=>{ctx.sync.stop();ctx.db.close();});const a=service==='gmail'?await connected(ctx,Object.values(GMAIL_SCOPES)):await connectedOutlook(ctx,[`${G}Mail.ReadWrite`,`${G}Mail.Send`]);const box=service==='gmail'?createGmailOutbox(ctx):createOutlookOutbox(ctx),m=ctx.store.createComposition(a.id);
 const input={mode:'new',text:'Texte à conserver pendant la saisie',to:'camille@',cc:'',subject:'Fictif',baseVersion:m.draftVersion};const saved=await box.saveDraft(m.id,input);assert.equal(saved.synced,false);assert.equal(ctx.store.getMessage(m.id).draft.text,input.text);await assert.rejects(box.preview(m.id,{...input,baseVersion:saved.version}),e=>e.status===400);assert.equal((service==='gmail'?ctx.g.sent:ctx.ms.sent).length,0);
});

test('historique : textes identiques à la même seconde restent des messages distincts entre pages',t=>{
 const store=seeded(t),wa=store.upsertAccount('perso',{name:'Doublons légitimes',channel:'whatsapp',svc:'whatsapp'}),jid='33600000000@s.whatsapp.net';store.waAddMessages(wa.id,Array.from({length:8},(_,i)=>({chatJid:jid,msgId:'different-'+i,fromMe:false,ts:1000,text:'OK'})));const id=store.upsertThread(wa.id,{...store.getMessage(1),externalId:jid,body:'OK',sortAt:1000,trail:[],count:8});let cursor=null,ids=[];do{const p=store.getMessage(id,{limit:3,before:cursor});ids.push(...p.trail.map(t=>t.id));cursor=p.history.nextCursor;}while(cursor);assert.equal(ids.length,7);assert.equal(new Set(ids).size,7);
 const a=store.upsertAccount('perso',{name:'Courrier ancien',channel:'email',svc:'gmail'}),trail=Array.from({length:5},()=>({from:'Fictif',at:1000,body:'OK'})),mid=store.upsertThread(a.id,{...store.getMessage(1),externalId:'legacy',sortAt:1001,trail,count:6});const first=store.getMessage(mid,{limit:2}),second=store.getMessage(mid,{limit:3,before:first.history.nextCursor});assert.equal(new Set([...first.trail,...second.trail].map(t=>t.id)).size,5);
});

test('WhatsApp direct send retains exact payload when AI provenance changes during queue wait',async t=>{const store=seeded(t),a=store.upsertAccount('perso',{name:'WA test',svc:'whatsapp',channel:'whatsapp',address:'+33600000000'}),id=store.upsertThread(a.id,{...store.getMessage(1),externalId:'33600000001@s.whatsapp.net',trail:[],body:'Hello',reply:null});let gate,release,sent=0;const sync={rebuild(){},onForget(){},isWhatsApp:()=>true,permissions:()=>['read','send'],serial:async(_id,fn)=>{if(gate)await gate;return fn();},generation:()=>1,liveSocket:()=>({sendMessage:async()=>{sent++;return{};}})};const box=createWhatsAppOutbox({store,sync}),input={text:'Typed by me',mode:'reply'},preview=await box.preview(id,input);gate=new Promise(r=>{release=r;});const pending=box.send(id,{...input,digest:preview.digest,direct:true});store.markDraftAI(id);release();assert.equal((await pending).sent,true);assert.equal(sent,1);});
