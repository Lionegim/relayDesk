import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ME,PEER,setupWhatsApp,linkedAccount,msg,tick} from './whatsapp-helpers.js';

const SELF=`${ME}@s.whatsapp.net`,LID='123456789012345@lid',LID_USER=LID.split('@')[0];
async function fixture(t){
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});
 const {accountId,sock}=await linkedAccount(c,{messages:[]});return{...c,accountId,sock};
}
const count=(c,jid)=>c.store.waChatMessages(c.accountId,jid).length;

test('a phone policy update clears the stale self LID policy and imports the next non-disappearing self message',async t=>{
 const c=await fixture(t);c.sock.auth.state.creds.me.lid=LID;
 c.sock.emit('chats.update',[{id:LID,ephemeralExpiration:86400}]);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('old','excluded',{chat:LID,fromMe:true,ago:1})]});assert.equal(count(c,LID),0);
 c.sock.emit('chats.update',[{id:SELF,ephemeralExpiration:0}]);
 assert.ok(!c.store.waEphemeralChats(c.accountId).includes(LID));
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('new','Synthetic self test',{chat:LID,fromMe:true,ago:0})]});await tick();
 assert.equal(count(c,LID),1);assert.equal(c.store.waChatMessages(c.accountId,LID)[0].text,'Synthetic self test');
 assert.equal(c.sock.sent.length,0);
});

test('enabling disappearing messages through either authenticated alias purges and blocks both identities',async t=>{
 const c=await fixture(t);c.sock.auth.state.creds.me.lid=LID;
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('p','Phone',{chat:SELF,fromMe:true}),msg('l','LID',{chat:LID,fromMe:true})]});
 assert.equal(count(c,SELF)+count(c,LID),2);
 c.sock.emit('chats.update',[{id:SELF,ephemeralExpiration:86400}]);assert.equal(count(c,SELF)+count(c,LID),0);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('blocked','Private',{chat:LID,fromMe:true})]});assert.equal(count(c,LID),0);
 c.sock.emit('chats.update',[{id:LID,ephemeralExpiration:0}]);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('allowed','Regular',{chat:SELF,fromMe:true})]});assert.equal(count(c,SELF),1);
 c.sock.emit('chats.update',[{id:LID,ephemeralExpiration:86400}]);assert.equal(count(c,SELF),0);
});

test('verified encrypted peer mapping shares policy without linking an unrelated account or group',async t=>{
 const c=await fixture(t),phone=PEER.split('@')[0],other='33611111111@s.whatsapp.net',group='120363123456@g.us';
 await c.sock.auth.state.keys.set({'lid-mapping':{[phone]:LID_USER,[LID_USER+'_reverse']:phone}});
 c.sock.emit('chats.update',[{id:PEER,ephemeralExpiration:86400}]);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('x','Private',{chat:LID}),msg('other','Visible',{chat:other}),msg('group','Group',{chat:group})]});
 assert.equal(count(c,LID),0);assert.equal(count(c,other),1);assert.equal(count(c,group),1);
 const otherAccount=c.store.upsertAccount('anove',{name:'Other WhatsApp',channel:'whatsapp',svc:'whatsapp'});
 assert.ok(!c.store.waEphemeralChats(otherAccount.id).includes(LID));
 c.sock.emit('chats.update',[{id:LID,ephemeralExpiration:0}]);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('next','Visible',{chat:PEER})]});assert.equal(count(c,PEER),1);
});

test('inconsistent or cross-account encrypted mappings do not clear a different conversation policy',async t=>{
 const c=await fixture(t),phone=PEER.split('@')[0];
 c.sock.emit('chats.update',[{id:LID,ephemeralExpiration:86400}]);
 await c.sock.auth.state.keys.set({'lid-mapping':{[phone]:LID_USER,[LID_USER+'_reverse']:'33600000000'}});
 c.sock.emit('chats.update',[{id:PEER,ephemeralExpiration:0}]);assert.ok(c.store.waEphemeralChats(c.accountId).includes(LID));
 const alien=c.vault.seal(999,{t:'lid-mapping',i:phone,v:JSON.stringify(LID_USER)});
 c.store.waAuthSet(c.accountId,'lid-mapping',phone,alien);
 c.sock.emit('chats.update',[{id:PEER,ephemeralExpiration:0}]);assert.ok(c.store.waEphemeralChats(c.accountId).includes(LID));
});

test('turning a conversation timer off never imports messages carrying ephemeral or view-once metadata',async t=>{
 const c=await fixture(t);c.sock.auth.state.creds.me.lid=LID;
 c.sock.emit('chats.update',[{id:SELF,ephemeralExpiration:0}]);
 const expired=msg('exp','ignored',{chat:LID});expired.message={extendedTextMessage:{text:'Disappearing',contextInfo:{expiration:86400}}};
 const wrapped=msg('wrapped','ignored',{chat:LID});wrapped.message={ephemeralMessage:{message:{conversation:'Disappearing'}}};
 const once=msg('once','ignored',{chat:LID});once.message={viewOnceMessageV2:{message:{conversation:'Private'}}};
 c.sock.emit('messages.upsert',{type:'notify',messages:[expired,wrapped,once]});assert.equal(count(c,LID),0);
});


test('late alias learning purges already imported text when either identity has an active disappearing policy',async t=>{
 const c=await fixture(t),phone=PEER.split('@')[0];
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('before','Previously visible',{chat:LID})]});assert.equal(count(c,LID),1);
 c.sock.emit('chats.update',[{id:PEER,ephemeralExpiration:86400}]);assert.equal(count(c,LID),1,'the identities are not yet authenticated as aliases');
 await c.sock.auth.state.keys.set({'lid-mapping':{[phone]:LID_USER,[LID_USER+'_reverse']:phone}});
 assert.equal(count(c,LID),0);assert.ok(c.store.waEphemeralChats(c.accountId).includes(LID));
 c.sock.emit('chats.update',[{id:PEER,ephemeralExpiration:0}]);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('after','Allowed now',{chat:LID})]});assert.equal(count(c,LID),1);
});

test('startup reconciles restrictive policies using existing authenticated mappings without inferring timer OFF',async t=>{
 const c=await fixture(t),phone=PEER.split('@')[0];
 await c.sock.auth.state.keys.set({'lid-mapping':{[phone]:LID_USER,[LID_USER+'_reverse']:phone}});
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('before-restart','Old visible text',{chat:LID})]});assert.equal(count(c,LID),1);
 // Reproduce a pre-fix persisted policy which only knew the phone identity.
 c.store.waSetEphemeral(c.accountId,PEER,true);assert.equal(count(c,LID),1);
 c.wa.sync.stop();await c.wa.sync.start();await tick();const sock=c.sockets.last();sock.user={id:`${ME}:7@s.whatsapp.net`};sock.emit('connection.update',{connection:'open'});await tick();
 assert.equal(count(c,LID),0);assert.ok(c.store.waEphemeralChats(c.accountId).includes(LID));
});


test('a late authenticated own-LID credential update purges prior self text under the phone policy',async t=>{
 const c=await fixture(t);
 c.sock.emit('messages.upsert',{type:'notify',messages:[msg('own-before','Self text',{chat:LID,fromMe:true})]});assert.equal(count(c,LID),1);
 c.sock.emit('chats.update',[{id:SELF,ephemeralExpiration:86400}]);assert.equal(count(c,LID),1);
 c.sock.auth.state.creds.me.lid=LID;c.sock.emit('creds.update',{});
 assert.equal(count(c,LID),0);assert.ok(c.store.waEphemeralChats(c.accountId).includes(LID));
});
