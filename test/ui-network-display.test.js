import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {safeMailHtml,readMailDisplay} from '../src/mail/display.js';
import {bodyText} from '../src/providers/outlook/parse.js';
function setup(t){const db=openDatabase(':memory:');seedIfEmpty(db,{demo:false});t.after(()=>db.close());const store=createStore(db);const a=store.upsertAccount('perso',{name:'Test',channel:'email',svc:'gmail',address:'owner@example.test'}),b=store.upsertAccount('anove',{name:'Work',channel:'email',svc:'outlook',address:'owner@work.test'});store.importContacts(a.id,[{externalId:'a',name:'Alex',identities:[{kind:'email',value:'alex@example.test'}]},{externalId:'b',name:'Alex other',identities:[{kind:'email',value:'other@example.test'}]}]);return{db,store,a,b,contacts:store.snapshot().contacts};}
const thread=(store,a,extra={})=>store.upsertThread(a.id,{externalId:'thread',from:'Alex',handle:'alex@example.test',initials:'A',sortAt:Date.now(),unread:false,flagged:false,archived:false,label:'Perso',subject:'Test',preview:'Hello',body:'Hello',triage:'',trail:[],count:1,participants:[{kind:'email',value:'alex@example.test'}],reply:{at:extra.sortAt || Date.now()},...extra});
test('email HTML preserves semantic structure while stripping active content and tracking resources',()=>{
 const s=safeMailHtml('<html><head><style>body{display:none}</style></head><body><h2>Budget</h2><table><tr><td>€12</td></tr></table><script>alert(1)</script><img src="https://tracker.test/pixel"><a href="javascript:alert(1)" onclick="bad()">bad</a><a href="https://example.test" id="root" data-on-click="send">safe</a><svg><a href="x">SVG</a></svg><form action="/api/send"><input></form></body></html>');
 assert.match(s,/<h2>Budget<\/h2>/);assert.match(s,/<td>€12<\/td>/);assert.match(s,/href="https:\/\/example.test"/);assert.match(s,/noopener noreferrer/);assert.doesNotMatch(s,/script|tracker|onclick|javascript|data-on|<svg|<form|<input|id=/);
 assert.equal(bodyText({body:{contentType:'html',content:'<p>Hello <b>Alex</b></p><p>Thanks</p>'}}),'Hello Alex\nThanks');
});
test('display source cached per content revision; discarded if account disconnects; drafts untouched',async t=>{
 const {store,a,db}=setup(t),stamp=Date.now(),id=thread(store,a,{sortAt:stamp,body:'Hello Alex'});store.saveDraft(id,'Keep me',{mode:'reply'});let reads=0,live=true;
 const provider={sync:{exclusive:async(a,fn)=>fn({live:()=>live,gmail:{getThread:async()=>{reads++;return{messages:[{id:'m1',internalDate:String(stamp),payload:{mimeType:'text/html',body:{data:Buffer.from('<p>Hello <b>Alex</b></p>').toString('base64url')}}}]};}}})}};
 const mail={providerFor:()=>provider};const first=await readMailDisplay({store,mail,id});assert.match(first.latest,/<b>Alex<\/b>/);await readMailDisplay({store,mail,id});assert.equal(reads,1);assert.equal(store.getMessage(id).draft.text,'Keep me');
 thread(store,a,{body:'New body',sortAt:Date.now()+1});live=false;await assert.rejects(readMailDisplay({store,mail,id}),e=>e.code==='history_changed');assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_display').get().n,1);
});
test('network counts individual dated messages in the selected period, not whole historical threads',t=>{
 const {store,a,b,contacts}=setup(t),now=Date.now(),day=86400000;
 thread(store,a,{sortAt:now-1000,trail:[{id:'old',at:now-120*day,body:'old'},{id:'recent',at:now-10*day,body:'recent'},{id:'unknown',body:'undated'}],count:4});
 thread(store,b,{externalId:'work',sortAt:now-1000});
 let n=store.contactNetwork('perso',{days:30,now}).nodes.find(c=>c.id===contacts[0].id);assert.equal(n.messages,2);assert.equal(n.lastAt,now-1000);
 thread(store,a,{externalId:'undated',sortAt:now,reply:{at:null}});
 n=store.contactNetwork('perso',{days:365,now}).nodes.find(c=>c.id===contacts[0].id);assert.equal(n.messages,3);assert.throws(()=>store.contactNetwork('perso',{days:7}),/Période/);
});
test('manual groups persist through local and unified merge/undo, with scope validation',t=>{
 const {store,a,b,contacts:[left,right]}=setup(t),g=store.savePersonGroup('perso',{name:'Friends'});store.personGroupMembership('perso',g.id,right.id,true);
 store.importContacts(a.id,[{externalId:'b',name:'Updated',identities:[{kind:'email',value:'other@example.test'}]}]);assert.deepEqual(store.contactNetwork('perso').groups[0].members,[right.id]);
 const event=store.mergeContacts('perso',left.id,right.id).merges[0].id;assert.deepEqual(store.contactNetwork('perso').groups[0].members,[left.id]);store.undoContactMerge('perso',event);assert.deepEqual(store.contactNetwork('perso').groups[0].members,[right.id]);
 store.importContacts(b.id,[{externalId:'work',name:'Work Alex',identities:[{kind:'email',value:'work@example.test'}]}]);const work=store.snapshot().contacts.find(c=>c.p==='anove');assert.throws(()=>store.personGroupMembership('perso',g.id,work.id,true),/profil/);assert.throws(()=>store.savePersonGroup('perso',{name:'Friends'}),/existe/);
 const all=store.savePersonGroup('all',{name:'All friends'});store.personGroupMembership('all',all.id,work.id,true);const merge=store.mergeContacts('all',left.id,work.id).merges[0].id;assert.deepEqual(store.contactNetwork('all').groups[0].members,[left.id]);store.undoContactMerge('all',merge);assert.deepEqual(store.contactNetwork('all').groups[0].members,[work.id]);store.personGroupMembership('all',all.id,work.id,false);assert.deepEqual(store.contactNetwork('all').groups[0].members,[]);
});
test('provider tree preserves actual parent and literal slash names, without rewriting local folders',t=>{
 const {store,b}=setup(t);store.syncProviderFolders(b.id,[{externalId:'p',name:'Projects',path:'Projects'},{externalId:'c',parentId:'p',name:'LoadMaster / RST',path:'Projects/LoadMaster / RST'}]);const f=store.snapshot().folders,child=f.find(c=>c.name==='LoadMaster / RST');assert.equal(child.parent,f.find(c=>c.name==='Projects').id);assert.equal(child.accountId,b.id);assert.equal(store.folderPath(child.id),'Projects/LoadMaster / RST');
 const local=store.createFolder({profileId:'anove',name:'Custom'});store.linkFolderLabel(local.id,b.id,'local');store.syncProviderFolders(b.id,[{externalId:'local',name:'Remote',path:'Remote'}]);assert.equal(store.folderPath(local.id),'Custom');
});
test('a new Gmail reply cannot display beneath the stored sender header',async t=>{
 const {store,a}=setup(t),at=Date.now(),id=thread(store,a,{sortAt:at});const mail={providerFor:()=>({sync:{exclusive:async(a,fn)=>fn({live:()=>true,gmail:{getThread:async()=>({messages:[{id:'new',internalDate:String(at+1000),payload:{mimeType:'text/plain',body:{data:Buffer.from('New reply').toString('base64url')}}}]})}})}})};
 await assert.rejects(readMailDisplay({store,mail,id}),e=>e.code==='history_changed');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mail_display').get().n,0);
});
test('Outlook displays existing plain-text imports by stable message identity despite HTML conversion differences',async t=>{
 const {store,b,db}=setup(t),at=Date.now(),id=thread(store,b,{sortAt:at,body:'Graph converted text with spacing',reply:{at,messageId:'<stable@example.test>'}});
 const mail={providerFor:()=>({sync:{exclusive:async(a,fn)=>fn({live:()=>true,graph:{conversation:async()=>[{id:'old',internetMessageId:'<stable@example.test>',receivedDateTime:new Date(at).toISOString(),body:{contentType:'html',content:'<p>Graph <strong>converted</strong> text</p>'}},{id:'new',internetMessageId:'<new@example.test>',receivedDateTime:new Date(at+1000).toISOString(),body:{contentType:'html',content:'<p>NEW REPLY</p>'}}]}})}})};
 const display=await readMailDisplay({store,mail,id});assert.match(display.latest,/<strong>converted<\/strong>/);assert.doesNotMatch(display.latest,/NEW REPLY/);assert.equal(display.items.new,undefined);
});
test('direct WhatsApp LID conversations count available dated messages; groups do not',t=>{
 const {store,db,contacts}=setup(t),now=Date.now(),wa=store.upsertAccount('perso',{name:'WA test',channel:'whatsapp',svc:'whatsapp',address:'+33611111111'});
 const id=thread(store,wa,{externalId:'12345@lid',sortAt:now-1000,participants:[{kind:'email',value:'alex@example.test'}]});db.prepare('INSERT INTO whatsapp_messages(account_id,chat_jid,msg_id,from_me,ts,text) VALUES(?,?,?,?,?,?)').run(wa.id,'12345@lid','one',1,now-1000,'Fictional');
 thread(store,wa,{externalId:'12345@g.us',sortAt:now-1000,participants:[{kind:'email',value:'alex@example.test'}]});db.prepare('INSERT INTO whatsapp_messages(account_id,chat_jid,msg_id,from_me,ts,text) VALUES(?,?,?,?,?,?)').run(wa.id,'12345@g.us','group',1,now-1000,'Fictional');
 assert.equal(store.contactNetwork('perso',{days:30,now}).nodes.find(n=>n.id===contacts[0].id).messages,1);
});
test('custom mailbox views include archived labelled Gmail threads and unread rollups',t=>{
 const {store,a}=setup(t);store.syncProviderFolders(a.id,[{externalId:'parent',name:'Projects',path:'Projects'},{externalId:'child',name:'Client',path:'Projects/Client',parentId:'parent'}]);const folders=store.snapshot().folders,parent=folders.find(f=>f.name==='Projects'),child=folders.find(f=>f.name==='Client');const id=thread(store,a,{archived:true,unread:true,folderId:child.id});
 const page=store.snapshot({profile:'perso',folder:parent.id});assert.deepEqual(page.messages.map(m=>m.id),[id]);assert.equal(page.counts.folderUnread[parent.id],1);assert.equal(store.snapshot({profile:'perso'}).messages.length,0);
 const local=store.createFolder({profileId:'perso',name:'Local'}),localChild=store.createFolder({profileId:'perso',name:'Linked child',parentId:local.id});store.linkFolderLabel(localChild.id,a.id,'extra');assert.equal(store.snapshot().folders.find(f=>f.id===localChild.id).accountId,null);
});
test('owner identities stay at the center rather than becoming a second network person',t=>{
 const {store,a}=setup(t);store.importContacts(a.id,[{externalId:'self',name:'Owner',identities:[{kind:'email',value:'owner@example.test'},{kind:'email',value:'former@example.test'}]}]);thread(store,a,{participants:[{kind:'email',value:'former@example.test'}]});const node=store.contactNetwork('perso').nodes.find(n=>n.name==='Owner');assert.equal(node.owner,true);assert.equal(node.messages,0);
});
