import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupWhatsApp,linkedAccount,msg,PEER,tick} from './whatsapp-helpers.js';
import {createSessionAccess} from '../src/http/session-access.js';
import {parseMessage} from '../src/providers/whatsapp/parse.js';
const thread=(ctx,account)=>ctx.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(account,PEER).id;
test('quoted reply uses retained same-chat message, survives draft save, binds preview and clears after delivery',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c,{messages:[msg('A1','Jeudi ?'),msg('A2','Ou vendredi ?', {ago:100})]});const id=thread(c,accountId);
 const draft=await c.wa.outbox.saveDraft(id,{text:'Jeudi !',replyTo:'A1',baseVersion:c.store.assertDraftVersion(id)});
 assert.equal(draft.replyTo,'A1');assert.equal(c.store.getMessage(id).draft.quote.body,'Jeudi ?');
 const input={text:'Jeudi !',replyTo:'A1',baseVersion:draft.version};const p=await c.wa.outbox.preview(id,input);
 assert.equal(p.quote.body,'Jeudi ?');assert.equal(sock.sent.length,0);
 await assert.rejects(()=>c.wa.outbox.send(id,{...input,replyTo:'A2',digest:p.digest}),{code:'digest_mismatch'});
 await assert.rejects(()=>c.wa.outbox.preview(id,{...input,replyTo:'NOPE'}),{code:'quote_unavailable'});
 await c.wa.outbox.send(id,{...input,digest:p.digest});
 assert.equal(sock.sent[0].options.quoted.key.id,'A1');assert.equal(sock.sent[0].options.quoted.message.conversation,'Jeudi ?');assert.equal(sock.sent[0].jid,PEER);
 const full=c.store.getMessage(id);assert.equal(full.quote.id,'A1');assert.equal(full.draft,null);
});
test('AI quote cannot bypass approval and a changed quote invalidates session approval',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c);const id=thread(c,accountId);c.store.markDraftAI(id);
 const input={text:'Bien sûr',replyTo:'A1',baseVersion:c.store.assertDraftVersion(id)};const p=await c.wa.outbox.preview(id,input);
 await assert.rejects(()=>c.wa.outbox.send(id,{...input,digest:p.digest,direct:true}),{code:'preview_required'});assert.equal(sock.sent.length,0);
 const a=createSessionAccess(),session={id:'test'};const ticket=a.rememberPreview(session,id,input,p);
 assert.throws(()=>a.consumePreview(session,id,{...input,replyTo:null,digest:p.digest,approvalToken:ticket.approvalToken}),{code:'session_approval_invalid'});
 a.consumePreview(session,id,{...input,digest:p.digest,approvalToken:ticket.approvalToken});
});
test('reactions add, replace, remove, ignore stale events, and notify without unread changes',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c);const id=thread(c,accountId);c.store.updateMessage(id,{unread:false});
 await c.wa.outbox.react(id,{messageId:'A1',emoji:'👍'});let full=c.store.getMessage(id);assert.deepEqual(full.reactions,[{emoji:'👍',count:1,mine:true}]);assert.equal(full.unread,false);
 assert.equal(sock.sent[0].content.react.key.id,'A1');assert.equal(sock.sent[0].jid,PEER);
 await c.wa.outbox.react(id,{messageId:'A1',emoji:'❤️'});assert.equal(c.store.getMessage(id).reactions.length,1);
 await c.wa.outbox.react(id,{messageId:'A1',emoji:''});assert.deepEqual(c.store.getMessage(id).reactions,[]);
 const key={remoteJid:PEER,id:'A1',fromMe:false};const event=(text,ts)=>({key,reaction:{key:{remoteJid:PEER,id:'r',fromMe:false},text,senderTimestampMs:ts}});
 sock.emit('messages.reaction',[event('😂',200)]);await tick();assert.equal(c.store.getMessage(id).reactions[0].emoji,'😂');
 sock.emit('messages.reaction',[event('',300),event('😂',100)]);await tick();assert.deepEqual(c.store.getMessage(id).reactions,[]);
 assert.ok(c.store.getMessage(id).interactionVersion>0);
 await assert.rejects(()=>c.wa.outbox.react(id,{messageId:'OTHER_CHAT',emoji:'👍'}),{code:'quote_unavailable'});
 await assert.rejects(()=>c.wa.outbox.react(id,{messageId:'A1',emoji:'<script>'}),{status:400});
});
test('incoming quotes use references only; unknown quotes never import embedded private content',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c);const id=thread(c,accountId);
 const raw=msg('Q1','ignored',{ago:10});raw.message={extendedTextMessage:{text:'Réponse',contextInfo:{stanzaId:'A1',quotedMessage:{conversation:'UNTRUSTED'}}}};
 sock.emit('messages.upsert',{type:'notify',messages:[raw]});await tick();assert.equal(c.store.getMessage(id).quote.body,'Bonjour, on se voit jeudi ?');
 raw.key.id='Q2';raw.message.extendedTextMessage.contextInfo.stanzaId='missing';sock.emit('messages.upsert',{type:'notify',messages:[raw]});await tick();assert.equal(c.store.getMessage(id).quote.unavailable,true);assert.ok(!JSON.stringify(c.store.getMessage(id)).includes('UNTRUSTED'));
 raw.message.extendedTextMessage.contextInfo.expiration=60;assert.equal(parseMessage(raw),null);
});
test('reaction failure is never retried and groups remain read-only',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const group='123456789@g.us';const {accountId,sock}=await linkedAccount(c,{messages:[msg('A1','hi'),msg('G1','group',{chat:group})]});const id=thread(c,accountId),gid=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(accountId,group).id;
 await assert.rejects(()=>c.wa.outbox.react(gid,{messageId:'G1',emoji:'👍'}),{code:'compose_unavailable'});
 sock.failSend=true;await assert.rejects(()=>c.wa.outbox.react(id,{messageId:'A1',emoji:'👍'}),{code:'send_uncertain'});await tick();assert.equal(sock.sent.length,0);assert.deepEqual(c.store.getMessage(id).reactions,[]);
 c.store.waPruneBefore(accountId,Date.now());assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_reactions').get().n,0);
});

test('queued reactions refuse a replaced connection and queued quotes refuse pruned targets',async t=>{
 const {createWhatsAppOutbox}=await import('../src/providers/whatsapp/outbox.js');
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c,{messages:[msg('A1','Old'),msg('A2','New',{ago:10})]});const id=thread(c,accountId);
 let release,epoch=1;const sync={onForget(){},isWhatsApp:()=>true,permissions:()=>['send'],generation:()=>epoch,liveSocket:()=>sock,serial:(_,fn)=>new Promise(r=>release=r).then(fn)};
 const out=createWhatsAppOutbox({store:c.store,sync});
 const pending=out.react(id,{messageId:'A1',emoji:'👍'});epoch++;release();await assert.rejects(()=>pending,{code:'account_changed'});assert.equal(sock.sent.length,0);
 const input={text:'Reply',replyTo:'A1'};const p=await out.preview(id,input);const queued=out.send(id,{...input,digest:p.digest});
 c.db.prepare('DELETE FROM whatsapp_messages WHERE account_id=? AND chat_jid=? AND msg_id=?').run(accountId,PEER,'A1');release();await assert.rejects(()=>queued,{code:'quote_unavailable'});assert.equal(sock.sent.length,0);
});
test('trusted replay enriches existing message with missing quote reference without duplicates',async t=>{
 const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const {accountId,sock}=await linkedAccount(c,{messages:[msg('A1','Hello'),msg('A2','Reply',{ago:10})]});const id=thread(c,accountId);
 const raw=msg('A2','Reply',{ago:10});raw.message={extendedTextMessage:{text:'Reply',contextInfo:{stanzaId:'A1'}}};sock.emit('messages.upsert',{type:'append',messages:[raw]});await tick();
 assert.equal(c.store.getMessage(id).quote.id,'A1');assert.equal(c.store.waChatMessages(accountId,PEER).length,2);
 assert.deepEqual(c.store.waInteractions(id,['A2'])[0].quote.id,'A1');
});
test('emoji validation accepts a single Unicode reaction, not text or multiple reactions',async()=>{
 const {validReaction}=await import('../src/providers/whatsapp/interactions.js');
 for(const e of ['','👍🏽','❤️','🔥','🇫🇷','1️⃣','👨‍👩‍👧'])assert.equal(validReaction(e),true,e);
 for(const e of ['hello','<script>','👍👍','1','\n',null])assert.equal(validReaction(e),false,String(e));
});
