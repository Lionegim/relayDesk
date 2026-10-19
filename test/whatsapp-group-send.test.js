import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupWhatsApp,linkedAccount,msg,tick,ME,PEER} from './whatsapp-helpers.js';
const GROUP='120363111222@g.us',ALICE='123456789012345@lid',BOB='33622222222@s.whatsapp.net';
async function group(t){const c=await setupWhatsApp();t.after(()=>c.wa.sync.stop());const a=msg('alice','On se voit jeudi ?',{chat:GROUP,pushName:'Alice'});a.key.participant=ALICE;const b=msg('bob','Vendredi pour moi',{chat:GROUP,pushName:'Bob',ago:100});b.key.participant=BOB;const {accountId,sock}=await linkedAccount(c,{messages:[a,b,msg('direct','Conversation privée',{chat:PEER})]});c.store.waSetChatName(accountId,GROUP,'Équipe · Démonstration');return {...c,accountId,sock,id:c.db.prepare('select id from messages where account_id=? and external_id=?').get(accountId,GROUP).id};}
test('group quoted reply binds group and original participant; AI cannot use direct-send bypass',async t=>{
 const c=await group(t);c.store.markDraftAI(c.id);
 const draft=await c.wa.outbox.saveDraft(c.id,{text:'Oui, jeudi !',replyTo:'alice',baseVersion:c.store.assertDraftVersion(c.id)});
 const input={text:draft.text,replyTo:draft.replyTo,baseVersion:draft.version};const p=await c.wa.outbox.preview(c.id,input);
 assert.deepEqual(p.to,['Groupe · Équipe · Démonstration']);assert.equal(p.group,true);assert.equal(p.quote.author,'Alice');assert.equal(p.quote.participantJid,ALICE);
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...input,direct:true,digest:p.digest}),{code:'preview_required'});assert.equal(c.sock.sent.length,0);
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...input,replyTo:'bob',digest:p.digest}),{code:'digest_mismatch'});
 await c.wa.outbox.send(c.id,{...input,digest:p.digest,to:PEER});
 assert.equal(c.sock.sent[0].jid,GROUP);assert.deepEqual(c.sock.sent[0].options.quoted.key,{remoteJid:GROUP,id:'alice',fromMe:false,participant:ALICE});
 assert.equal(c.store.getMessage(c.id).quote.author,'Alice');assert.equal(c.store.getMessage(c.id).draft,null);
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...input,digest:p.digest}),{code:'confirmation_invalid'});
});
test('group reactions target participant, combine authors, replace/remove only my reaction',async t=>{
 const c=await group(t);
 await c.wa.outbox.react(c.id,{messageId:'alice',emoji:'👍'});assert.deepEqual(c.sock.sent[0].content.react.key,{remoteJid:GROUP,id:'alice',fromMe:false,participant:ALICE});
 c.sock.emit('messages.reaction',[{key:{remoteJid:GROUP,id:'alice'},reaction:{key:{remoteJid:GROUP,participant:BOB,fromMe:false},text:'👍',senderTimestampMs:Date.now()}}]);await tick();
 assert.deepEqual(c.store.getMessage(c.id).trail.find(m=>m.waId==='alice').reactions,[{emoji:'👍',count:2,mine:true}]);
 await c.wa.outbox.react(c.id,{messageId:'alice',emoji:'❤️'});await c.wa.outbox.react(c.id,{messageId:'alice',emoji:''});
 assert.deepEqual(c.store.getMessage(c.id).trail.find(m=>m.waId==='alice').reactions,[{emoji:'👍',count:1,mine:false}]);
 await assert.rejects(()=>c.wa.outbox.react(c.id,{messageId:'direct',emoji:'👍'}),{code:'quote_unavailable'});
 await assert.rejects(()=>c.wa.outbox.preview(c.id,{text:'x',replyTo:'direct'}),{code:'quote_unavailable'});
});
test('group replies and reactions to own message preserve self identity and media preview',async t=>{
 const c=await group(t);const input={text:'Bonjour groupe'};let p=await c.wa.outbox.preview(c.id,input);await c.wa.outbox.send(c.id,{...input,digest:p.digest});const own=c.store.getMessage(c.id).waId;
 await c.wa.outbox.react(c.id,{messageId:own,emoji:'🎉'});assert.equal(c.sock.sent[1].content.react.key.fromMe,true);assert.equal(c.sock.sent[1].content.react.key.participant,`${ME}@s.whatsapp.net`);
 // Small synthetic PNG signature (same fixture accepted by the media module's format sniffer).
 const image=await c.wa.media.upload(c.id,Buffer.from([137,80,78,71,13,10,26,10,0,0]));
 const reply={text:'Voici la maquette',replyTo:own,attachmentId:image.id};p=await c.wa.outbox.preview(c.id,reply);assert.equal(p.quote.author,'Vous');assert.equal(p.attachment.id,image.id);
 await c.wa.outbox.send(c.id,{...reply,digest:p.digest});assert.equal(c.sock.sent[2].jid,GROUP);assert.equal(c.sock.sent[2].options.quoted.key.participant,`${ME}@s.whatsapp.net`);assert.equal(c.sock.sent[2].content.mimetype,'image/png');
});
test('group identity edits invalidate preview; missing author and disappearing group refuse without sends',async t=>{
 const c=await group(t);const input={text:'Réponse',replyTo:'alice'};const p=await c.wa.outbox.preview(c.id,input);
 c.db.prepare('update whatsapp_messages set author_jid=? where account_id=? and chat_jid=? and msg_id=?').run(BOB,c.accountId,GROUP,'alice');
 await assert.rejects(()=>c.wa.outbox.send(c.id,{...input,digest:p.digest}),{code:'digest_mismatch'});
 c.db.prepare('update whatsapp_messages set author_jid=NULL where account_id=? and chat_jid=?').run(c.accountId,GROUP);
 await assert.rejects(()=>c.wa.outbox.preview(c.id,input),{code:'quote_author_unavailable'});
 await assert.rejects(()=>c.wa.outbox.react(c.id,{messageId:'bob',emoji:'👍'}),{code:'quote_author_unavailable'});
 assert.equal(c.store.getMessage(c.id).canInteract,false);
 c.sock.emit('chats.update',[{id:GROUP,ephemeralExpiration:86400}]);await tick();
 await assert.rejects(()=>c.wa.outbox.preview(c.id,{text:'x'}),{status:404});assert.equal(c.sock.sent.length,0);
});
test('installed Baileys wire format retains group quoted sender for PN/LID and owner identity',async()=>{
 const {loadBaileys}=await import('../src/providers/whatsapp/socket.js');const lib=await loadBaileys();
 for(const [fromMe,participant,expected] of [[false,ALICE,ALICE],[false,BOB,BOB],[true,'987654321234567@lid',`${ME}@s.whatsapp.net`]]) {
  const generated=lib.generateWAMessageFromContent(GROUP,{extendedTextMessage:{text:'Réponse'}},{userJid:`${ME}@s.whatsapp.net`,quoted:{key:{remoteJid:GROUP,id:'g1',fromMe,participant},message:{conversation:'Original'}}});
  const ctx=generated.message.extendedTextMessage.contextInfo;
  assert.equal(ctx.stanzaId,'g1');assert.equal(ctx.participant,expected);assert.equal(ctx.quotedMessage.conversation,'Original');
 }
});
test('group becoming ephemeral during delivery never recreates purged history',async t=>{
 const c=await group(t),input={text:'Réponse validée',replyTo:'alice'};const p=await c.wa.outbox.preview(c.id,input);
 let finish,started;const ready=new Promise(r=>started=r);
 c.sock.sendMessage=async()=>{started();return new Promise(r=>finish=r);};
 const pending=c.wa.outbox.send(c.id,{...input,digest:p.digest});await ready;
 c.sock.emit('chats.update',[{id:GROUP,ephemeralExpiration:86400}]);await tick();
 finish({key:{id:'OUT',fromMe:true,remoteJid:GROUP}});assert.equal((await pending).sent,true);
 assert.equal(c.store.waChatMessages(c.accountId,GROUP).length,0);assert.equal(c.store.threadState(c.accountId,GROUP),null);
});
