import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createCipheriv,createHmac} from 'node:crypto';
import {setupWhatsApp,linkedAccount,msg,PEER,tick} from './whatsapp-helpers.js';
import {parseMessage} from '../src/providers/whatsapp/parse.js';
import {createWhatsAppMedia} from '../src/providers/whatsapp/media.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
const mediaKeys={cipherKey:Buffer.alloc(32,1),iv:Buffer.alloc(16,2),macKey:Buffer.alloc(32,3)};
const cipher=createCipheriv('aes-256-cbc',mediaKeys.cipherKey,mediaKeys.iv),ciphertext=Buffer.concat([cipher.update(png),cipher.final()]);
const encryptedPNG=Buffer.concat([ciphertext,createHmac('sha256',mediaKeys.macKey).update(mediaKeys.iv).update(ciphertext).digest().subarray(0,10)]);
const image=(id,extra={})=>({...msg(id,''),message:{imageMessage:{url:'https://mmg.whatsapp.net/fictional',mimetype:'image/png',fileLength:png.length,caption:'Souvenir 😊',mediaKey:Buffer.from('private-key'),...extra}}});
const idFor=(c,aid)=>c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(aid,PEER).id;
test('media import is deduplicated, captioned, encrypted, paginated and erased with ephemeral policy',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});
 const {accountId,sock}=await linkedAccount(c,{messages:[image('photo',{contextInfo:{quotedMessage:{viewOnceMessage:{message:{conversation:'quoted secret'}}}}})]});const id=idFor(c,accountId);
 const full=c.store.getMessage(id);assert.equal(full.body,'Souvenir 😊');assert.equal(full.media.mime,'image/png');assert.ok(full.media.url);
 const stored=c.db.prepare('SELECT * FROM whatsapp_media').get();assert.equal(JSON.stringify(c.vault.open(accountId,stored)).includes('quoted secret'),false);assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from('private-key')),false);assert.equal(JSON.stringify(full).includes('mediaKey'),false);
 sock.emit('messages.upsert',{type:'notify',messages:[image('photo'),msg('next','Merci ❤️',{ago:0})]});await tick();
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM whatsapp_media').get().n,1);
 assert.equal(c.store.getMessage(id,{limit:10}).trail[0].media.id,full.media.id);
 c.store.waSetEphemeral(accountId,PEER,true);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM whatsapp_media').get().n,0);
});
test('media keeps view-once, disappearing, unsupported and oversized messages excluded',()=>{
 for(const k of ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension'])assert.equal(parseMessage({...image('x'),message:{[k]:{message:image('y').message}}}),null);
 assert.equal(parseMessage(image('x',{contextInfo:{expiration:86400}})),null);
 assert.equal(parseMessage(image('x',{viewOnce:true})),null);
 assert.equal(parseMessage({...image('v'),message:{videoMessage:{mimetype:'video/mp4',fileLength:100,gifPlayback:true,viewOnce:true,caption:'private'}}}),null);
 assert.equal(parseMessage(image('x',{fileLength:11*1024*1024,caption:''})),null);
 const gif={...msg('g',''),message:{videoMessage:{mimetype:'video/mp4',gifPlayback:true,fileLength:200}}};assert.equal(parseMessage(gif).media.kind,'gif');
 assert.equal(parseMessage({...gif,message:{videoMessage:{...gif.message.videoMessage,gifPlayback:false}}}),null);
});
test('attachment-only sends bind exact bytes to one-use preview; upload is conversation-bound',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId,sock}=await linkedAccount(c);const id=idFor(c,accountId);
 const a=await c.wa.media.upload(id,png),b=await c.wa.media.upload(id,Buffer.concat([png,Buffer.from('different')]));
 await assert.rejects(c.wa.media.upload(id,Buffer.from('<svg>')),/Format/);
 const input={text:'',attachmentId:a.id};const preview=await c.wa.outbox.preview(id,input);
 assert.equal(preview.attachment.id,a.id);assert.equal(preview.body,'');
 await assert.rejects(c.wa.outbox.send(id,{...input,attachmentId:b.id,digest:preview.digest}),e=>e.code==='digest_mismatch');
 await c.wa.outbox.send(id,{...input,digest:preview.digest,direct:true});assert.deepEqual(sock.sent[0].content.image,png);
 assert.equal(c.store.getMessage(id).media.mime,'image/png');
 await assert.rejects(c.wa.outbox.send(id,{...input,digest:preview.digest}),e=>e.code==='confirmation_invalid');
 const other=msg('other','Bonjour',{chat:'33600000000@s.whatsapp.net'});sock.emit('messages.upsert',{type:'notify',messages:[other]});await tick();
 const oid=c.db.prepare('SELECT id FROM messages WHERE account_id=? AND external_id=?').get(accountId,other.key.remoteJid).id;
 assert.throws(()=>c.wa.media.draft(oid,a.id),e=>e.status===404);
 c.store.markDraftAI(id);const ai=await c.wa.outbox.preview(id,{text:'IA',attachmentId:b.id});
 await c.wa.outbox.send(id,{text:'IA',attachmentId:b.id,digest:ai.digest,direct:true});assert.equal(sock.sent.length,2);
});
test('media is lazy downloaded once, bounded and cache is private; deleted during download never returns bytes',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c,{messages:[image('photo')]});let downloads=0;
 const media=createWhatsAppMedia({store:c.store,vault:c.vault,socket:()=>({}),fetchMedia:async()=>{downloads++;return {ok:true,body:Readable.from([encryptedPNG])};},lib:async()=>({BufferJSON:{reviver:(_,v)=>v?.type==='Buffer'?Buffer.from(v.data,'base64'):v},getMediaKeys:async key=>{assert.equal(key.toString(),'private-key');return mediaKeys;}})});
 const id=c.store.getMessage(idFor(c,accountId)).media.id;
 assert.deepEqual((await media.get(id)).bytes,png);await media.get(id);assert.equal(downloads,1);
 assert.equal(Buffer.from(c.store.waMediaGet(id).ciphertext).includes(png),false);
 c.store.waSetEphemeral(accountId,PEER,true);await assert.rejects(media.get(id),e=>e.status===404);
});
test('animated GIF uploads convert to silent native WhatsApp video and preview those exact bytes',async t=>{
 const {spawnSync}=await import('node:child_process');const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=64x48:rate=3','-t','1','-f','gif','pipe:1']);assert.equal(result.status,0);
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {sock}=await linkedAccount(c);const id=c.db.prepare("SELECT id FROM messages WHERE channel='whatsapp' ORDER BY id DESC LIMIT 1").get().id;
 const a=await c.wa.media.upload(id,result.stdout);assert.equal(a.mime,'video/mp4');assert.equal(a.kind,'gif');
 const preview=await c.wa.outbox.preview(id,{text:'GIF 😊',attachmentId:a.id});assert.equal(preview.attachment.mime,'video/mp4');
 const bytes=(await c.wa.media.get(a.id)).bytes;
 await c.wa.outbox.send(id,{text:'GIF 😊',attachmentId:a.id,digest:preview.digest});assert.equal(sock.sent[0].content.gifPlayback,true);assert.deepEqual(sock.sent[0].content.video,bytes);
});
test('GIF conversion cannot attach to a conversation purged while converting',async t=>{
 const {readFileSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=64x48:rate=3','-t','1','-f','gif','pipe:1']);assert.equal(result.status,0);
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c);const id=idFor(c,accountId);
 const upload=c.wa.media.upload(id,result.stdout);c.store.waSetEphemeral(accountId,PEER,true);
 await assert.rejects(upload,e=>e.status===404);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM whatsapp_media').get().n,0);
});
test('private binary routes require owner session and CSRF, serve no-store and reject excessive uploads',async t=>{
 const {createApp}=await import('../src/http/app.js');const {HttpError}=await import('../src/http/errors.js');
 const c=await setupWhatsApp();const {accountId}=await linkedAccount(c);const id=idFor(c,accountId);let authenticated=false;
 const auth={handle:async()=>false,requireSession:()=>{if(!authenticated)throw new HttpError(401,'Sign in','auth_required');return{id:'owner'};},assertMutation:req=>{if(req.headers['x-csrf-token']!=='test')throw new HttpError(403,'CSRF','csrf_invalid');}};
 const app=createApp({store:c.store,ai:{configured:false},providers:{whatsapp:c.wa},auth});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.close(r));c.wa.sync.stop();c.db.close();});
 const origin=`http://127.0.0.1:${app.address().port}`,path=`${origin}/api/messages/${id}/whatsapp-media`;
 assert.equal((await fetch(path,{method:'POST',body:png})).status,401);authenticated=true;
 assert.equal((await fetch(path,{method:'POST',body:png})).status,403);
 let response=await fetch(path,{method:'POST',headers:{'x-csrf-token':'test'},body:png});assert.equal(response.status,200);const media=await response.json();
 response=await fetch(origin+media.url);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await fetch(path,{method:'POST',headers:{'x-csrf-token':'test'},body:Buffer.alloc(10*1024*1024+1)})).status,413);
 authenticated=false;assert.equal((await fetch(origin+media.url)).status,401);
});
test('installed Baileys prepares image and GIF media locally without a network upload',async()=>{
 const {loadBaileys}=await import('../src/providers/whatsapp/socket.js');const {prepareWAMessageMedia}=await loadBaileys();const {gifToVideo}=await import('../src/providers/whatsapp/media.js');
 const {spawnSync}=await import('node:child_process');const gif=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=64x48:rate=3','-t','1','-f','gif','pipe:1']);assert.equal(gif.status,0);const video=await gifToVideo(gif.stdout);
 const logger={debug(){},info(){},warn(){},error(){}};const upload=async()=>({mediaUrl:'https://mmg.whatsapp.net/fictional',directPath:'/fictional'});
 const photo=await prepareWAMessageMedia({image:png,mimetype:'image/png',caption:'😊'},{upload,logger});assert.equal(photo.imageMessage.caption,'😊');assert.equal(Number(photo.imageMessage.fileLength),png.length);
 const animation=await prepareWAMessageMedia({video,mimetype:'video/mp4',gifPlayback:true,caption:'🎉'},{upload,logger});assert.equal(animation.videoMessage.gifPlayback,true);assert.ok(animation.videoMessage.jpegThumbnail.length);
});
test('download watchdog releases slots even before response headers arrive',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c,{messages:[image('photo')]});const id=c.store.getMessage(idFor(c,accountId)).media.id;
 let rejectDownload,destroyed=0;
 const media=createWhatsAppMedia({store:c.store,vault:c.vault,socket:()=>({}),downloadTimeoutMs:20,makeDownloadAgent:()=>({dispatch(){},async destroy(error){if(error){destroyed++;rejectDownload(error);}}}),fetchMedia:async()=>new Promise((resolve,reject)=>{rejectDownload=reject;}),lib:async()=>({BufferJSON:{reviver:(_,v)=>v}})});
 for(let i=0;i<4;i++)await assert.rejects(media.get(id),e=>e.code==='media_unavailable');assert.equal(destroyed,4,'all timed-out slots are released');
});
test('an in-flight download cannot resurrect media after an ephemeral-policy purge',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c,{messages:[image('photo')]});const id=c.store.getMessage(idFor(c,accountId)).media.id;let release;
 const media=createWhatsAppMedia({store:c.store,vault:c.vault,socket:()=>({}),fetchMedia:async()=>new Promise(resolve=>{release=()=>resolve({ok:true,body:Readable.from([encryptedPNG])});}),lib:async()=>({BufferJSON:{reviver:(_,v)=>v},getMediaKeys:async()=>mediaKeys})});
 const result=media.get(id);await tick();c.store.waSetEphemeral(accountId,PEER,true);release();await assert.rejects(result,e=>e.code==='media_unavailable');assert.equal(c.store.waMediaGet(id),undefined);
});
test('body resets and tampered ciphertext fail safely without calling the unsafe Baileys pipe',async t=>{
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c,{messages:[image('photo')]});const id=c.store.getMessage(idFor(c,accountId)).media.id;
 let reset=true;const lib=async()=>({BufferJSON:{reviver:(_,v)=>v},getMediaKeys:async()=>mediaKeys,downloadMediaMessage:()=>{throw new Error('unsafe path must not be used');}});
 const media=createWhatsAppMedia({store:c.store,vault:c.vault,lib,socket:()=>({}),fetchMedia:async()=>({ok:true,body:Readable.from((async function*(){yield encryptedPNG.subarray(0,20);throw new Error('synthetic body reset');})())})});
 await assert.rejects(media.get(id),e=>e.code==='media_unavailable');
 const corrupted=Buffer.from(encryptedPNG);corrupted[20]^=1;
 const tampered=createWhatsAppMedia({store:c.store,vault:c.vault,lib,socket:()=>({}),fetchMedia:async()=>({ok:true,body:Readable.from([corrupted])})});await assert.rejects(tampered.get(id),e=>e.code==='media_unavailable');
});
test('downloader authenticates and decrypts media encrypted by the installed Baileys version',async t=>{
 const {loadBaileys}=await import('../src/providers/whatsapp/socket.js');const library=await loadBaileys();const {readFile}=await import('node:fs/promises');let uploaded;
 const prepared=await library.prepareWAMessageMedia({image:png,mimetype:'image/png',caption:'Interop 😊'},{logger:{debug(){},info(){},warn(){},error(){}},upload:async path=>{uploaded=await readFile(path);return{mediaUrl:'https://mmg.whatsapp.net/fictional',directPath:'/fictional'};}});
 const c=await setupWhatsApp();t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId}=await linkedAccount(c,{messages:[{...msg('interop',''),message:prepared}]});const id=c.store.getMessage(idFor(c,accountId)).media.id;
 const media=createWhatsAppMedia({store:c.store,vault:c.vault,socket:()=>({}),lib:async()=>library,fetchMedia:async()=>({ok:true,body:Readable.from([uploaded])})});assert.deepEqual((await media.get(id)).bytes,png);
});
