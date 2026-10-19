import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {parseContactFile,exportVCard,csvRows} from '../src/contacts/formats.js';
import {contactField} from '../src/contacts/fields.js';
import {createApp} from '../src/http/app.js';
import {HttpError} from '../src/http/errors.js';
function fixture(t){const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});const store=createStore(db);t.after(()=>db.close());return {db,store};}
const csv={format:'csv',text:'Name;Email;Phone;Company;Favorite color\r\n"Alice André";alice@example.test;+33611111111;Example;"green; sage"\r\n'};
test('standard fields and typed custom fields persist through provider reimport, merge and undo',t=>{
 const {store,db}=fixture(t),a=store.upsertAccount('perso',{svc:'gmail',channel:'email',name:'Test'});store.importContacts(a.id,[{externalId:'a',name:'Alice',identities:[{kind:'email',value:'a@example.test'}],fields:[{kind:'organization',value:'Acme'}]},{externalId:'b',name:'Alice B',identities:[],fields:[{kind:'notes',value:'Original B'}]}]);
 let [left,right]=store.snapshot().contacts;const original=left;left=store.addContactField('perso',left.id,{revision:left.fieldsRevision,field:{kind:'custom',label:'Score',type:'number',value:'12.5'}});assert.throws(()=>store.addContactField('perso',left.id,{revision:original.fieldsRevision,field:{kind:'notes',value:'stale'}}),{code:'contact_changed'});
 const score=left.fields.find(f=>f.kind==='custom');left=store.addContactField('perso',left.id,{revision:left.fieldsRevision,fieldId:score.id,field:{kind:'custom',label:'Score',type:'number',value:'15'}});assert.equal(left.fields.find(f=>f.id===score.id).value,'15');
 store.importContacts(a.id,[{externalId:'a',name:'Alice Updated',identities:[{kind:'email',value:'a@example.test'}],fields:[{kind:'organization',value:'New org'}]}]);left=store.person('perso',left.id);assert.equal(left.fields.find(f=>f.id===score.id).value,'15');assert.equal(left.fields.find(f=>f.kind==='organization').value,'New org');
 let merged=store.mergeContacts('perso',left.id,right.id);assert.equal(merged.fields.length,3);store.undoContactMerge('perso',merged.merges[0].id);assert.equal(store.person('perso',right.id).fields[0].value,'Original B');assert.equal(store.person('perso',left.id).fields.length,2);
 assert.throws(()=>store.person('anove',left.id),{status:404});const p=store.person('perso',left.id);assert.throws(()=>store.removeContactField('perso',left.id,{revision:p.fieldsRevision,fieldId:p.fields.find(f=>f.source==='gmail').id}),{status:400});assert.equal(createStore(db).person('perso',left.id).fields.find(f=>f.kind==='custom').value,'15');
});
test('unified field edits follow explicit links; unlink restores source records',t=>{
 const {store}=fixture(t);const a=store.contactFiles.create('perso',{name:'Alice P'}),b=store.contactFiles.create('anove',{name:'Alice Work'});let p=store.mergeContacts('all',a.id,b.id);p=store.addContactField('all',p.id,{revision:p.fieldsRevision,field:{kind:'custom',label:'Shared preference',value:'Tea'}});assert.equal(p.fields.length,1);const e=store.contactHistory('all')[0];store.undoContactMerge('all',e.id);assert.equal(store.person('anove',b.id).fields.length,0);assert.equal(store.person('perso',a.id).fields.length,1);
});
test('CSV preview maps unknown columns, handles quotes/newlines and imports atomically without exact reimport duplicates',t=>{
 const {store}=fixture(t),p=store.contactFiles.preview('perso',csv);assert.equal(p.total,1);assert.equal(p.sample[0].fields.find(f=>f.kind==='custom').label,'Favorite color');assert.equal(store.snapshot().contacts.length,0);
 assert.deepEqual(store.contactFiles.commit('perso',{...csv,fingerprint:p.fingerprint}),{imported:1,skipped:0,profileId:'perso'});assert.equal(store.contactFiles.commit('perso',{...csv,fingerprint:p.fingerprint}).imported,0);assert.equal(store.snapshot().contacts.length,1);assert.equal(store.snapshot().contacts[0].fields.find(f=>f.kind==='custom').value,'green; sage');
 assert.throws(()=>store.contactFiles.commit('perso',{...csv,text:csv.text+'Bob;bad-mail;;;;\n',fingerprint:p.fingerprint}),{status:400});assert.equal(store.snapshot().contacts.length,1);assert.throws(()=>store.contactFiles.preview('all',csv),{status:400});
 assert.deepEqual(csvRows('Name,Notes\nAlice,"Line one\nLine two, here"\n'),[['Name','Notes'],['Alice','Line one\nLine two, here']]);assert.throws(()=>csvRows('a,b\nx,"unclosed'),{status:400});
});
test('vCard4 export round-trips Unicode, custom field types, birthday without year, notes, addresses and identities',t=>{
 const {store}=fixture(t),p=store.contactFiles.preview('perso',csv);store.contactFiles.commit('perso',{...csv,fingerprint:p.fingerprint});let c=store.snapshot().contacts[0];
 for(const field of [{kind:'birthday',value:'--02-29'},{kind:'notes',value:'Été; thé, café\nSecond line'},{kind:'address',value:'1 rue des Tests\nParis'},{kind:'custom',type:'boolean',label:'Coffee?',value:'false'},{kind:'custom',label:'Long unicode',value:'é'.repeat(120)}])c=store.addContactField('perso',c.id,{revision:c.fieldsRevision,field});
 const text=store.contactFiles.export('perso');assert.ok(text.split('\r\n').every(line=>Buffer.byteLength(line)<=75));const parsed=parseContactFile({format:'vcf',text});assert.equal(parsed.records[0].name,'Alice André');assert.equal(parsed.records[0].fields.find(f=>f.kind==='birthday').value,'--02-29');assert.equal(parsed.records[0].fields.find(f=>f.label==='Coffee?').type,'boolean');assert.equal(parsed.records[0].fields.find(f=>f.kind==='notes').value,'Été; thé, café\nSecond line');assert.equal(store.contactFiles.commit('perso',{format:'vcf',text,fingerprint:parsed.fingerprint}).imported,0,'own exported contact UID is not duplicated');
 const changed=text.replace('FN:Alice André','FN:Alice André Updated');const change=store.contactFiles.preview('perso',{format:'vcf',text:changed});assert.equal(store.contactFiles.commit('perso',{format:'vcf',text:changed,fingerprint:change.fingerprint}).imported,1,'modified UID match remains reviewable as a new source');
 const target=store.contactFiles.preview('anove',{format:'vcf',text});store.contactFiles.commit('anove',{format:'vcf',text,fingerprint:target.fingerprint});assert.equal(store.snapshot().contacts.length,3);assert.ok(store.contactFiles.export('all').includes('VERSION:4.0'));
});
test('typed fields reject invalid numbers/dates/active links and invalid VCF fails with no partial writes',t=>{
 for(const field of [{kind:'birthday',value:'2025-02-29'},{kind:'website',value:'javascript:alert(1)'},{kind:'custom',label:'N',type:'number',value:'Infinity'},{kind:'custom',label:'B',type:'boolean',value:'yes'},{kind:'custom',label:'',value:'x'}])assert.throws(()=>contactField(field),{status:400});
 const {store}=fixture(t);assert.throws(()=>store.contactFiles.preview('perso',{format:'vcf',text:'BEGIN:VCARD\nVERSION:2.1\nFN:Alice\nEND:VCARD\n'}),{status:400});assert.throws(()=>parseContactFile({format:'csv',text:'x'.repeat(2*1024*1024+1)}),{status:400});assert.equal(store.snapshot().contacts.length,0);
});
test('authenticated contact field/file/export endpoints preserve content types and block unauthenticated exports',async t=>{
 const {store}=fixture(t),app=createApp({store});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}`;
 let r=await fetch(base+'/api/profiles/perso/contacts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Alice'})});assert.equal(r.status,200);const c=await r.json();r=await fetch(base+`/api/profiles/perso/contacts/${c.id}/fields`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:c.fieldsRevision,field:{kind:'custom',label:'Color',value:'Green'}})});assert.equal(r.status,200);
 r=await fetch(base+'/api/profiles/perso/contacts.vcf');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/vcard/);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-disposition'),/attachment/);assert.match(await r.text(),/FN:Alice/);
 const guarded=createApp({store,auth:{handle:async()=>false,requireSession(){throw new HttpError(401,'Sign in');}}});await new Promise(r=>guarded.listen(0,'127.0.0.1',r));t.after(()=>guarded.close());assert.equal((await fetch(`http://127.0.0.1:${guarded.address().port}/api/profiles/all/contacts.vcf`)).status,401);
});

test('vCard3 binary photo is safely ignored while structured names/addresses survive vCard4 export',()=>{
 const source='BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dr Alice André\r\nN:André;Alice;Louise;Dr;PhD\r\nNICKNAME:Ali\r\nORG:Studio;Design\r\nTEL;TYPE=HOME:06 11 22 33 44\r\nADR;TYPE=WORK:;;1 rue du Test;Paris;;75001;France\r\nPHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=\r\n aGVsbG8=\r\nEND:VCARD\r\n';const p=parseContactFile({format:'vcf',text:source});assert.equal(p.records.length,1);assert.equal(p.records[0].fields.find(f=>f.kind==='address').components[3],'Paris');
 const record=p.records[0],text=exportVCard([{...record,id:'synthetic',identities:record.identities.map(i=>({...i,normalized:'unresolved:'+i.value,needsCountryCode:true}))}]);const round=parseContactFile({format:'vcf',text});assert.equal(round.records[0].fields.find(f=>f.kind==='prefix').value,'Dr');assert.equal(round.records[0].fields.find(f=>f.kind==='department').value,'Design');assert.equal(round.records[0].identities[0].value,'06 11 22 33 44');assert.equal(round.records[0].fields.find(f=>f.kind==='address').components[5],'75001');
});

test('display names and structured addresses cannot create an unimportable exported contact',()=>{
 for(const value of ['First\nSecond','x'.repeat(201)])assert.throws(()=>contactField({kind:'displayName',value}),{status:400});assert.throws(()=>contactField({kind:'address',value:'Valid display',components:['','','hidden\0nul','','','','']}),{status:400});
 const text=exportVCard([{id:'test',name:'Alice',identities:[],fields:[{kind:'notes',value:'Line one\rLine two'}]}]);assert.equal(parseContactFile({format:'vcf',text}).records[0].fields[0].value,'Line one\nLine two');
});
test('CSV mapping stays available after invalid auto-mapped values, and type columns are preserved as custom fields',t=>{
 const {store}=fixture(t),input={format:'csv',text:'Name,Email,Email Type\nAlice,not-an-email,Work\n'};const preview=store.contactFiles.preview('perso',input);assert.ok(preview.error);assert.deepEqual(preview.mapping,['name','email','custom']);assert.equal(preview.fingerprint,undefined);const fixed=store.contactFiles.preview('perso',{...input,mapping:['name','custom','custom']});assert.equal(fixed.total,1);assert.equal(fixed.sample[0].fields.length,2);
});
