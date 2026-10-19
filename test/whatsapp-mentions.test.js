import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupWhatsApp,linkedAccount,msg,PEER,tick} from './whatsapp-helpers.js';
import {readMentions} from '../src/providers/whatsapp/mentions.js';
import {createSessionAccess} from '../src/http/session-access.js';
const GROUP='120363112233@g.us',ALICE='123456789012345@lid',BOB='33622222222@s.whatsapp.net';
async function setup(t){const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const original=msg('g1','Bonjour',{chat:GROUP,pushName:'Alice'});original.key.participant=ALICE;const {accountId,sock}=await linkedAccount(c,{messages:[original,msg('direct','privé')]});sock.groupMembers=[{id:ALICE,name:'Alice',phoneNumber:'33611111111@s.whatsapp.net'},{id:BOB,name:'Bob'}];c.store.waSetChatName(accountId,GROUP,'Équipe');const id=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(accountId,GROUP).id;return {...c,accountId,sock,id};}
const input=()=>({text:'Bonjour @123456789012345 !',mentions:[{jid:ALICE,start:8,end:24}]});
test('group participants come from authenticated metadata; draft mentions persist and send native PN/LID mentions',async t=>{
 const c=await setup(t);const {members:list}=await c.wa.participants(c.id);assert.equal(list.length,2);assert.equal(list[0].name,'Alice');assert.equal(list[0].phone,'+33611111111');assert.equal(c.sock.sent.length,0);
 const value=input(),d=await c.wa.outbox.saveDraft(c.id,{...value,baseVersion:c.store.assertDraftVersion(c.id)});assert.equal(d.mentions[0].name,'Alice');assert.equal(c.store.getMessage(c.id).draft.mentions[0].jid,ALICE);
 const p=await c.wa.outbox.preview(c.id,{...value,baseVersion:d.version});assert.equal(p.body,value.text);assert.equal(p.mentions[0].name,'Alice');
 await c.wa.outbox.send(c.id,{...value,digest:p.digest});assert.equal(c.sock.sent[0].jid,GROUP);assert.deepEqual(c.sock.sent[0].content.mentions,[ALICE]);assert.equal(c.store.getMessage(c.id).mentions[0].name,'Alice');assert.equal(c.store.getMessage(c.id).draft,null);
});
test('edited ranges, nonmembers and direct-chat mentions are rejected without delivery',async t=>{
 const c=await setup(t),v=input();
 for(const mentions of [[{...v.mentions[0],start:7}],[...v.mentions,...v.mentions],[{jid:PEER,start:0,end:1}]])await assert.rejects(()=>c.wa.outbox.preview(c.id,{...v,mentions}),{status:400});
 c.sock.groupMembers=[];await assert.rejects(()=>c.wa.outbox.preview(c.id,v),{code:'mention_unavailable'});
 const id=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(c.accountId,PEER).id;await assert.rejects(()=>c.wa.outbox.preview(id,v),{status:400});assert.equal(c.sock.sent.length,0);
});
test('membership is refreshed at send time; removed member and changed mention approvals refuse',async t=>{
 const c=await setup(t),v=input();c.store.markDraftAI(c.id);let p=await c.wa.outbox.preview(c.id,v);
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...v,digest:p.digest,direct:true}),{code:'preview_required'});
 const access=createSessionAccess(),s={id:'session'},ticket=access.rememberPreview(s,c.id,v,p);assert.throws(()=>access.consumePreview(s,c.id,{...v,mentions:[],digest:p.digest,approvalToken:ticket.approvalToken}),{code:'session_approval_invalid'});
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...v,mentions:[],digest:p.digest}),{code:'digest_mismatch'});
 c.sock.groupMembers=[];await assert.rejects(()=>c.wa.outbox.send(c.id,{...v,digest:p.digest}),{code:'mention_unavailable'});assert.equal(c.sock.sent.length,0);
});
test('participant lookup failure and policy purge while metadata is pending cannot send or save',async t=>{
 const c=await setup(t),v=input();c.sock.groupMetadata=async()=>{throw new Error('offline');};await assert.rejects(()=>c.wa.outbox.preview(c.id,v),{code:'participants_unavailable'});
 let resolve,started;const ready=new Promise(r=>started=r);c.sock.groupMetadata=()=>{started();return new Promise(r=>resolve=r);};const pending=c.wa.outbox.preview(c.id,v);await ready;
 c.sock.emit('chats.update',[{id:GROUP,ephemeralExpiration:86400}]);await tick();resolve({id:GROUP,participants:c.sock.groupMembers});await assert.rejects(()=>pending,{code:'account_changed'});assert.equal(c.sock.sent.length,0);
});
test('incoming native mention metadata is retained without importing quoted payload',async t=>{
 const c=await setup(t);const raw=msg('native','ignored',{chat:GROUP,ago:10});raw.key.participant=BOB;raw.message={extendedTextMessage:{text:input().text,contextInfo:{mentionedJid:[ALICE],quotedMessage:{conversation:'secret'}}}};c.sock.emit('messages.upsert',{type:'notify',messages:[raw]});await tick();const m=c.store.getMessage(c.id);assert.equal(m.mentions[0].jid,ALICE);assert.equal(m.mentions[0].start,8);assert.ok(!JSON.stringify(m).includes('secret'));
});
test('installed Baileys places selected mentions in native contextInfo',async()=>{
 const {loadBaileys}=await import('../src/providers/whatsapp/socket.js');const lib=await loadBaileys();const content=await lib.generateWAMessageContent({text:input().text,mentions:[ALICE,BOB]},{});assert.deepEqual(content.extendedTextMessage.contextInfo.mentionedJid,[ALICE,BOB]);
 assert.throws(()=>readMentions(Array(51).fill(input().mentions[0]),input().text),{status:400});
});
test('token boundaries reject digit extensions and trusted replay backfills mention metadata',async t=>{
 const c=await setup(t),v=input();
 assert.throws(()=>readMentions(v.mentions,v.text.slice(0,24)+'9'+v.text.slice(24)),{status:400});
 assert.throws(()=>readMentions([{...v.mentions[0],start:9,end:25}],v.text.slice(0,8)+'x'+v.text.slice(8)),{status:400});
 const raw=msg('legacy',v.text,{chat:GROUP,ago:10});raw.key.participant=BOB;c.sock.emit('messages.upsert',{type:'append',messages:[raw]});await tick();const before=c.store.getMessage(c.id).interactionVersion;
 raw.message={extendedTextMessage:{text:v.text,contextInfo:{mentionedJid:[ALICE]}}};c.sock.emit('messages.upsert',{type:'append',messages:[raw]});await tick();
 assert.equal(c.store.getMessage(c.id).mentions[0].jid,ALICE);assert.ok(c.store.getMessage(c.id).interactionVersion>before);assert.equal(c.store.waChatMessages(c.accountId,GROUP).length,2);
});
