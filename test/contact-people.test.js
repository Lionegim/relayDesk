import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {importAddressBook} from '../src/contacts/import.js';
import {normalizeIdentity} from '../src/contacts/identity.js';
function fixture(t){const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});const store=createStore(db);t.after(()=>db.close());const gmail=store.upsertAccount('perso',{name:'Google test',channel:'email',svc:'gmail',address:'owner@example.test'});const outlook=store.upsertAccount('anove',{name:'Outlook test',channel:'email',svc:'outlook',address:'owner@work.test'});return{db,store,gmail,outlook};}
const rec=(id,name,email,phone)=>({externalId:id,name,identities:[{kind:'email',value:email},{kind:'phone',value:phone}]});
const contacts=(s,p)=>s.snapshot().contacts.filter(c=>c.p===p);
function thread(store,account,id,participants,body='body@example.test') {return store.upsertThread(account,{externalId:id,from:'Example',initials:'E',handle:'owner@example.test',sortAt:Date.now(),unread:true,flagged:false,label:'Perso',subject:id,preview:body,body,triage:'',trail:[],count:1,archived:false,participants});}
test('identities: explicit country, case only for emails, no plus/dot alias inference',()=>{
 assert.equal(normalizeIdentity('phone','06 12 34 56 78'),null);assert.equal(normalizeIdentity('phone','0033 (6) 12-34-56-78'),'+33612345678');assert.equal(normalizeIdentity('email','A.B+tag@EXAMPLE.test'),'a.b+tag@example.test');
});
test('imports are idempotent, preserve manual identities and never merge names or profiles',t=>{
 const {store,gmail,outlook}=fixture(t);const a=rec('1','Alex','Alex@example.test','+33612345678');
 store.importContacts(gmail.id,[a]);const first=contacts(store,'perso')[0];store.addContactIdentity('perso',first.id,{kind:'email',value:'other@example.test'});store.importContacts(gmail.id,[{...a,name:'Alex updated'}]);
 assert.equal(contacts(store,'perso').length,1);assert.equal(contacts(store,'perso')[0].identities.length,3);
 store.importContacts(outlook.id,[a]);assert.equal(contacts(store,'anove').length,1);assert.throws(()=>store.mergeContacts('perso',first.id,contacts(store,'anove')[0].id),/profil/);
 store.importContacts(gmail.id,[rec('2','Alex updated','different@example.test','0612345678')]);assert.equal(contacts(store,'perso').length,2);assert.equal(contacts(store,'perso')[1].identities.find(i=>i.kind==='phone').needsCountryCode,true);
});
test('person timeline matches sent recipient, never bodies/own address/other profile; threads deduplicate',t=>{
 const {store,gmail,outlook}=fixture(t);store.importContacts(gmail.id,[rec('a','A','person@example.test','+33612345678')]);const person=contacts(store,'perso')[0];
 const id=thread(store,gmail.id,'sent',[{kind:'email',value:'person@example.test'},{kind:'email',value:'owner@example.test'}]);
 thread(store,gmail.id,'signature',[{kind:'email',value:'else@example.test'}],'person@example.test');thread(store,outlook.id,'work',[{kind:'email',value:'person@example.test'}]);
 const p=store.person('perso',person.id);assert.deepEqual(p.timeline.items.map(m=>m.id),[id]);
 store.addContactIdentity('perso',person.id,{kind:'email',value:'owner@example.test'});assert.equal(store.person('perso',person.id).timeline.total,1);
 assert.throws(()=>store.person('anove',person.id),/profil/);
});
test('merge/unmerge is reversible, no source record lost, later merges require reverse order',t=>{
 const {store,gmail}=fixture(t);store.importContacts(gmail.id,[rec('a','A','a@example.test'),rec('b','B','b@example.test'),rec('c','C','c@example.test')]);const [a,b,c]=contacts(store,'perso');
 const first=store.mergeContacts('perso',a.id,b.id).merges[0].id;assert.equal(contacts(store,'perso').length,2);const second=store.mergeContacts('perso',c.id,a.id).merges[0].id;
 assert.throws(()=>store.undoContactMerge('perso',first),/fusion suivante/);store.undoContactMerge('perso',second);store.undoContactMerge('perso',first);assert.equal(contacts(store,'perso').length,3);
});
test('manual identifier removal works for a merged member, imported source remains immutable',t=>{
 const {store,gmail}=fixture(t);store.importContacts(gmail.id,[rec('a','A','a@example.test'),rec('b','B','b@example.test')]);const [a,b]=contacts(store,'perso');store.addContactIdentity('perso',b.id,{kind:'email',value:'wrong@example.test'});store.mergeContacts('perso',a.id,b.id);
 store.removeContactIdentity('perso',a.id,{source:'manual',kind:'email',normalized:'wrong@example.test'});assert.equal(store.person('perso',a.id).identities.some(i=>i.value==='wrong@example.test'),false);assert.throws(()=>store.removeContactIdentity('perso',a.id,{source:'gmail',kind:'email',normalized:'a@example.test'}));
});
test('shared identifiers produce review candidates, not implicit person merges',t=>{
 const {store,gmail}=fixture(t);store.importContacts(gmail.id,[rec('a','A','shared@example.test'),rec('b','B','shared@example.test')]);const [a,b]=contacts(store,'perso');assert.deepEqual(store.person('perso',a.id).candidates.map(x=>x.id),[b.id]);assert.equal(contacts(store,'perso').length,2);
 thread(store,gmail.id,'shared',[{kind:'email',value:'shared@example.test'}]);assert.equal(store.person('perso',a.id).timeline.total,0);assert.equal(store.person('perso',a.id).identities[0].sharedWith,2);store.mergeContacts('perso',a.id,b.id);assert.equal(store.person('perso',a.id).timeline.total,1);
});
test('import service requires contacts permission and discards a disconnected account response',async t=>{
 const {store,gmail}=fixture(t);let live=true;
 const provider={sync:{permissions:()=>[],exclusive:()=>{throw new Error('must not run');}}};await assert.rejects(importAddressBook({store,provider,accountId:gmail.id}),e=>e.code==='contacts_permission');
 provider.sync.permissions=()=>['contacts'];provider.sync.exclusive=async(id,fn)=>fn({gmail:{contacts:async()=>{live=false;return[rec('a','A','a@example.test')];}},live:()=>live});
 await assert.rejects(importAddressBook({store,provider,accountId:gmail.id}),e=>e.code==='account_changed');assert.equal(contacts(store,'perso').length,0);
});

test('database rejects direct cross-profile grouping',t=>{
 const {store,db,gmail,outlook}=fixture(t);store.importContacts(gmail.id,[rec('a','A','a@example.test')]);store.importContacts(outlook.id,[rec('b','B','a@example.test')]);const a=contacts(store,'perso')[0],b=contacts(store,'anove')[0];
 assert.throws(()=>db.prepare('INSERT INTO contact_person_links VALUES (?,?)').run(a.id,b.id),/profile mismatch/);
 assert.equal(store.person('perso',a.id).candidates.length,0);
});
