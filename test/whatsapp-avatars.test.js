import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupWhatsApp,linkedAccount,msg,PEER} from './whatsapp-helpers.js';
import {HttpError} from '../src/http/errors.js';
import {createApp} from '../src/http/app.js';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X2kAAAAASUVORK5CYII=','base64');
async function setup(t,options={}) {
 let downloads=0;const c=await setupWhatsApp({avatarOptions:{fetchPhoto:async()=>{downloads++;return new Response(PNG);},...options}});t.after(()=>c.wa.sync.stop());
 const {accountId,sock}=await linkedAccount(c);let lookups=0;sock.profilePictureUrl=async()=>{lookups++;return 'https://pps.whatsapp.net/photo.jpg';};
 const m=c.store.snapshot().messages.find(m=>m.accountId===accountId);return {...c,accountId,sock,m,scope:m.conversationIdentity,counts:()=>({downloads,lookups})};
}
test('private avatar bytes coalesce across list/header and contact; provider URLs stay server-side',async t=>{
 const c=await setup(t);const photos=await Promise.all(Array.from({length:8},()=>c.wa.avatars.get('messages',c.m.id,c.scope)));
 assert.equal(photos[0].mime,'image/png');assert.deepEqual(photos[0].bytes,PNG);assert.deepEqual(c.counts(),{downloads:1,lookups:1});
 const person=c.store.snapshot().contacts.find(p=>p.avatarUrl);assert.ok(person);const url=new URL(person.avatarUrl,'http://localhost');
 const photo=await c.wa.avatars.get('contacts',url.pathname.split('/')[3],url.searchParams.get('scope'));assert.deepEqual(photo.bytes,PNG);assert.equal(c.counts().downloads,1);
 assert.ok(!JSON.stringify(c.store.snapshot()).includes('pps.whatsapp.net'));assert.equal(c.sock.sent.length,0);
});
test('hidden or unsupported photos use a negative cache; no external or active content fetched',async t=>{
 for(const url of ['https://evil.example/a.jpg','https://pps.whatsapp.net:8443/a','http://pps.whatsapp.net/a','https://pps.whatsapp.net@127.0.0.1/a',null]) {
  const c=await setup(t);c.sock.profilePictureUrl=async()=>url;
  await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope));await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope));assert.equal(c.counts().downloads,0);
 }
 let n=0;const c=await setup(t,{fetchPhoto:async()=>{n++;return new Response('<svg onload="alert(1)"></svg>');}});
 await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope));await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope));assert.equal(n,1);
});
test('avatar rejects oversized bytes and an unresponsive profile query without blocking synchronization',async t=>{
 const c=await setup(t,{fetchPhoto:async()=>new Response(Buffer.alloc(1024*1024+1))});await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope));
 const d=await setup(t,{timeoutMs:15});d.sock.profilePictureUrl=()=>new Promise(()=>{});await assert.rejects(d.wa.avatars.get('messages',d.m.id,d.scope));assert.equal(d.sock.sent.length,0);
});
test('photo cannot cross a replaced conversation, account disconnect, or privacy purge during download',async t=>{
 for(const mutate of ['replace','disconnect','purge']) {
  let resolve;const c=await setup(t,{fetchPhoto:()=>new Promise(r=>resolve=r)});const request=c.wa.avatars.get('messages',c.m.id,c.scope);while(!resolve)await new Promise(r=>setImmediate(r));
  if(mutate==='replace')c.db.prepare("UPDATE messages SET conversation_key='new-key' WHERE id=?").run(c.m.id);
  else if(mutate==='disconnect')await c.wa.disconnect(c.accountId);
  else c.db.prepare('DELETE FROM messages WHERE id=?').run(c.m.id);
  resolve(new Response(PNG));await assert.rejects(request);assert.equal(c.sock.sent.length,0);
 }
});
test('groups and their current participants have scoped photos; arbitrary participant lookup is rejected',async t=>{
 const c=await setup(t),group='120363123456@g.us',m=msg('group','Bonjour',{chat:group});m.key.participant=PEER;c.sock.emit('messages.upsert',{type:'notify',messages:[m]});
 await new Promise(r=>setTimeout(r,20));const g=c.store.snapshot().messages.find(m=>m.accountId===c.accountId && m.id!==c.m.id);assert.ok(g);c.sock.groupMembers=[{id:PEER,name:'Claire'}];
 const p=await c.wa.participants(g.id);assert.ok(p.members[0].avatarUrl);await c.wa.avatars.get('messages',g.id,g.conversationIdentity);await c.wa.avatars.get('messages',g.id,g.conversationIdentity,PEER);
 await assert.rejects(c.wa.avatars.get('messages',g.id,g.conversationIdentity,'33111111111@s.whatsapp.net'));await assert.rejects(c.wa.avatars.get('messages',c.m.id,c.scope,PEER));assert.equal(c.sock.sent.length,0);
});
test('avatar endpoint is authenticated, serves safe private bytes, and rejects stale scope',async t=>{
 const c=await setup(t),app=createApp({store:c.store,providers:{whatsapp:c.wa}});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}`;
 const r=await fetch(base+c.m.avatarUrl);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG);
 assert.equal((await fetch(`${base}/api/messages/${c.m.id}/whatsapp-avatar?scope=wrong`)).status,404);
 const guarded=createApp({store:c.store,providers:{whatsapp:c.wa},auth:{handle:async()=>false,requireSession(){throw new HttpError(401,'Sign in','unauthorized');}}});await new Promise(r=>guarded.listen(0,'127.0.0.1',r));t.after(()=>guarded.close());assert.equal((await fetch(`http://127.0.0.1:${guarded.address().port}${c.m.avatarUrl}`)).status,401);
});
