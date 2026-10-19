import {test} from 'node:test';import assert from 'node:assert/strict';
import {openDatabase} from '../src/db/index.js';import {seedIfEmpty} from '../src/db/seed.js';import {createStore} from '../src/store.js';import {detectDuplicates,createDuplicateWorker} from '../src/contacts/duplicates.js';
function fixture(t){const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});const store=createStore(db);t.after(()=>db.close());const a=store.upsertAccount('perso',{name:'Google test',channel:'email',svc:'gmail',address:'owner@example.test'}),b=store.upsertAccount('anove',{name:'Outlook test',channel:'email',svc:'outlook',address:'owner@work.test'});return{db,store,a,b};}
const rec=(id,name,email,phone)=>({externalId:id,name,identities:[...(email?[{kind:'email',value:email}]:[]),...(phone?[{kind:'phone',value:phone}]:[])]});
const importPair=(s,a)=>s.importContacts(a.id,[rec('a','Alex Martin','alex@example.test'),rec('b','Alex alternate','alex@example.test')]);
test('background candidates explain exact identifiers and name order/accents, scoped to one profile',async t=>{
 const {store,a,b}=fixture(t);importPair(store,a);store.importContacts(a.id,[rec('c','Élodie Durand'),rec('d','Durand Elodie'),rec('e','Alex Different',null,'0612345678'),rec('f','Other Person',null,'0612345678')]);store.importContacts(b.id,[rec('a','Alex Martin','alex@example.test')]);
 await store.scanContactDuplicates('perso');const list=store.contactDuplicates('perso');assert.equal(list.items.length,2);assert.ok(list.items.some(x=>x.rank===2 && x.reasons[0].type==='email'));assert.ok(list.items.some(x=>x.rank===1 && x.reasons[0].type==='name'));assert.equal(store.contactDuplicates('anove').items.length,0);assert.equal(store.snapshot().contacts.length,7,'scanner never merges');
});
test('dismiss and restore persist; unchanged reimports stay dismissed, new evidence resurfaces',async t=>{
 const {store,a}=fixture(t);importPair(store,a);await store.scanContactDuplicates('perso');let c=store.contactDuplicates('perso').items[0];store.dismissContactDuplicate('perso',c.id,{version:c.version});await store.scanContactDuplicates('perso');assert.equal(store.contactDuplicates('perso').items[0].dismissed,true);
 importPair(store,a);await store.scanContactDuplicates('perso');assert.equal(store.contactDuplicates('perso').items[0].dismissed,true);store.dismissContactDuplicate('perso',c.id,{version:c.version,restore:true});assert.equal(store.contactDuplicates('perso').items[0].dismissed,false);
 store.dismissContactDuplicate('perso',c.id,{version:c.version});store.addContactIdentity('perso',c.left.id,{kind:'phone',value:'+33600000001'});await store.scanContactDuplicates('perso');assert.equal(store.contactDuplicates('perso').items[0].dismissed,false);
});
test('merge requires current exact pair, selected main record and explicit confirmation; undo preserves records',async t=>{
 const {store,a}=fixture(t);importPair(store,a);await store.scanContactDuplicates('perso');const c=store.contactDuplicates('perso').items[0];const input={version:c.version,keepId:c.left.id,confirm:true};assert.throws(()=>store.mergeContactDuplicate('anove',c.id,input),/introuvable/);assert.throws(()=>store.mergeContactDuplicate('perso',c.id,{...input,confirm:false}),/confirmer/);assert.throws(()=>store.mergeContactDuplicate('perso',c.id,{...input,keepId:'unknown'}));
 const r=store.mergeContactDuplicate('perso',c.id,input);assert.equal(store.snapshot().contacts.length,1);assert.equal(store.contactDuplicates('perso').items.length,0);store.undoContactMerge('perso',r.mergeId);await store.scanContactDuplicates('perso');assert.equal(store.snapshot().contacts.length,2);assert.equal(store.contactDuplicates('perso').items[0].dismissed,true,'undo does not immediately nag again');
});
test('stale reviewed pair cannot merge or dismiss after source change',async t=>{
 const {store,a}=fixture(t);importPair(store,a);await store.scanContactDuplicates('perso');const c=store.contactDuplicates('perso').items[0];store.importContacts(a.id,[rec('b','Different Person','different@example.test')]);assert.equal(store.contactDuplicates('perso').items[0].stale,true);assert.throws(()=>store.mergeContactDuplicate('perso',c.id,{version:c.version,keepId:c.left.id,confirm:true}),e=>e.code==='duplicate_changed');assert.throws(()=>store.dismissContactDuplicate('perso',c.id,{version:c.version}),e=>e.code==='duplicate_changed');await store.scanContactDuplicates('perso');assert.equal(store.contactDuplicates('perso').items.length,0);
});
test('scan discards results when records change during a yielded calculation',async t=>{
 const {store,a}=fixture(t);importPair(store,a);const job=store.scanContactDuplicates('perso');store.importContacts(a.id,[rec('b','Changed Person','other@example.test')]);assert.equal((await job).stale,true);assert.equal(store.contactDuplicates('perso').items.length,0);await store.scanContactDuplicates('perso');assert.equal(store.contactDuplicates('perso').pending,false);
});
test('crowded identifier buckets are bounded instead of generating quadratic candidates',async()=>{
 const many=Array.from({length:100},(_,i)=>({id:String(i),name:'Contact '+i,title:'',members:[String(i)],identities:[{kind:'email',normalized:'shared@example.test'}]}));const result=await detectDuplicates('perso',many);assert.equal(result.items.length,0);assert.equal(result.crowded,1);
});
test('worker updates after import and drains cleanly on stop',async t=>{
 const {store,a}=fixture(t);const worker=createDuplicateWorker(store,{debounceMs:5,intervalMs:60000});worker.start();importPair(store,a);for(let i=0;i<100 && store.contactDuplicates('perso').pending;i++)await new Promise(r=>setTimeout(r,5));assert.equal(store.contactDuplicates('perso').items.length,1);await worker.stop();store.addContactIdentity('perso',store.contactDuplicates('perso').items[0].left.id,{kind:'phone',value:'+33600000001'});assert.equal(store.contactDuplicates('perso').pending,true);
});

test('generic placeholders and first names are never name-match evidence',async()=>{
 const make=(id,name)=>({id,name,title:'',members:[id],identities:[]});for(const name of ['Contact sans nom','Contact WhatsApp','Contact','Alex']){const r=await detectDuplicates('perso',[make('a',name),make('b',name)]);assert.equal(r.items.length,0,name);}
});
