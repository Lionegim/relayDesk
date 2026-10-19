// Private, account-bound encrypted media. No provider URL or media key reaches the browser.
import {Agent,fetch as fetchMediaDefault} from 'undici';
import {spawn} from 'node:child_process';
import {randomUUID,createHash,createHmac,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {HttpError,badRequest,notFound} from '../../http/errors.js';
export const MAX_MEDIA=10*1024*1024;
const MAX_CACHE=512*1024*1024;
export function sniffMedia(b) {
  if(b.length>=8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b.length>=3 && b[0]===255 && b[1]===216 && b[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()))return 'image/gif';
  if(b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(b.length>=12 && b.subarray(4,8).toString()==='ftyp')return 'video/mp4';
  throw badRequest('Format non pris en charge : JPEG, PNG, WebP ou GIF.');
}
// WhatsApp plays GIFs as silent MP4 video. Convert locally, with bounded CPU, duration and output.
export async function gifToVideo(bytes) {
  if(bytes.length<10 || bytes.readUInt16LE(6)>4096 || bytes.readUInt16LE(8)>4096)throw badRequest('Dimensions GIF trop grandes.');
  return new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_threads','1','-i','pipe:0','-t','30','-an','-vf',"fps=15,scale='min(512,iw)':-2:flags=bilinear,pad=ceil(iw/2)*2:ceil(ih/2)*2",'-c:v','libx264','-threads','1','-preset','veryfast','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{stdio:['pipe','pipe','ignore']});
    let size=0;const chunks=[];let done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(new HttpError(422,'GIF illisible ou trop complexe : choisis un autre fichier.','gif_invalid'));}else resolve(Buffer.concat(chunks));};
    const timer=setTimeout(()=>finish(true),15000);
    child.on('error',()=>finish(true));child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_MEDIA)finish(true);else chunks.push(chunk);});
    child.on('close',code=>finish(code!==0 || !size));child.stdin.end(bytes);
  });
}
export function createWhatsAppMedia({store,vault,lib,socket=()=>null,canUpload=()=>true,generation=()=>0,downloadTimeoutMs=20000,fetchMedia=fetchMediaDefault,makeDownloadAgent=()=>new Agent({connect:{timeout:10000},headersTimeout:20000,bodyTimeout:20000})}) {
  const pending=new Map();let converting=false;
  const meta=r=>({id:r.id,mime:r.mime,kind:r.kind,size:r.size,url:`/api/whatsapp/media/${r.id}`});
  const open=r=>{const d=vault.open(r.account_id,r);if(d.id!==r.id)throw notFound();return d;};
  function put(accountId,fields,data) {
    store.waMediaSweep();
    if(store.waMediaBytes()+fields.size>MAX_CACHE)throw new HttpError(413,'Le cache média est plein.','media_cache_full');
    const id=randomUUID();store.waMediaPut({id,accountId,...fields,sealed:vault.seal(accountId,{id,...data})});
    return meta(store.waMediaGet(id));
  }
  function draft(messageId,id) {
    if(id==null)return null;
    if(typeof id!=='string')throw badRequest('Pièce jointe invalide.');
    store.waMediaSweep();const r=store.waMediaGet(id),ctx=store.composeContext(messageId);
    if(!r || r.owner_message!==messageId || r.account_id!==ctx.accountId)throw notFound('Pièce jointe absente ou expirée.');
    const d=open(r);return {...meta(r),bytes:Buffer.from(d.bytes,'base64'),hash:d.hash};
  }
  return {
    draft,
    capture(accountId,m,raw) {
      if(!m.media || store.waMediaFor(accountId,m.chatJid,m.msgId))return;
      try { // Raw protobuf buffers are serialized explicitly below.
        const encode=(_,v)=>v instanceof Uint8Array || v?.type==='Buffer'&&Array.isArray(v.data)?{type:'Buffer',data:Buffer.from(v.data || v).toString('base64')}:typeof v==='bigint'?v.toString():v;
        put(accountId,{chatJid:m.chatJid,msgId:m.msgId,...m.media},{raw:JSON.stringify(raw,encode)});
      } catch { /* A bounded cache must never interrupt text synchronization. */ }
    },
    async upload(messageId,bytes) {
      const ctx=store.composeContext(messageId),a=store.getAccount(ctx.accountId);
      if(!canUpload(ctx.accountId))throw new HttpError(403,'La permission Envoi n’est pas accordée.','send_forbidden');
      if(a.svc!=='whatsapp' || !ctx.threadId || ctx.threadId.endsWith('@g.us'))throw badRequest('Choisis une discussion WhatsApp individuelle.');
      if(!bytes.length || bytes.length>MAX_MEDIA)throw new HttpError(413,'Image trop volumineuse (10 Mo maximum).','too_large');
      let mime=sniffMedia(bytes);if(mime==='video/mp4')throw badRequest('Ajoute une image ou un fichier GIF.');
      const gif=mime==='image/gif';
      if(gif){
        if(converting)throw new HttpError(429,'Un GIF est déjà en préparation.','media_busy');
        // FK-bound marker prevents numeric ID reuse after a policy purge or disconnect.
        const marker=put(ctx.accountId,{ownerMessage:messageId,mime:'application/octet-stream',kind:'pending',size:0},{});
        const identity=store.accountIdentity(ctx.accountId),epoch=generation(ctx.accountId);converting=true;
        try {
          bytes=await gifToVideo(bytes);mime='video/mp4';
          if(!store.waMediaGet(marker.id) || !store.hasAccount(ctx.accountId) || store.accountIdentity(ctx.accountId)!==identity || generation(ctx.accountId)!==epoch || store.composeContext(messageId).threadId!==ctx.threadId || !canUpload(ctx.accountId))throw notFound('La discussion a changé : ajoute à nouveau le GIF.');
        }finally {converting=false;store.waMediaDelete(marker.id);}
      }
      if(!store.hasAccount(ctx.accountId) || store.composeContext(messageId).accountId!==ctx.accountId)throw notFound();
      return put(ctx.accountId,{ownerMessage:messageId,mime,kind:gif?'gif':'image',size:bytes.length},{bytes:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')});
    },
    async get(id) {
      const r=store.waMediaGet(id);if(!r)throw notFound();
      if(r.owner_message && r.created_at<Date.now()-86400000)throw notFound('Pièce jointe expirée.');
      const d=open(r);
      if(d.bytes)return {bytes:Buffer.from(d.bytes,'base64'),mime:r.mime};
      if(pending.has(id))return pending.get(id);
      if(pending.size>=3)throw new HttpError(429,'Chargement média en cours : réessaie.','media_busy');
      const agent=makeDownloadAgent();
      const timer=setTimeout(()=>{agent.destroy(new Error('media timeout')).catch(()=>{});},downloadTimeoutMs);
      const task=(async()=>{
        try {
          const library=await lib(),sock=socket(r.account_id);
          if(!sock)throw new Error();
          const raw=JSON.parse(d.raw,library.BufferJSON.reviver);
          const content=raw.message.imageMessage || raw.message.videoMessage || raw.message.documentMessage;
          if(content.url){const url=new URL(content.url);if(url.protocol!=='https:' || !/(^|\.)whatsapp\.net$/.test(url.hostname) || url.port || url.username || url.password)throw new Error();}
          if(content.directPath && (!content.directPath.startsWith('/') || content.directPath.startsWith('//')))throw new Error();
          const url=content.directPath?`https://mmg.whatsapp.net${content.directPath}`:content.url;
          const response=await fetchMedia(url,{dispatcher:agent,signal:AbortSignal.timeout(downloadTimeoutMs),redirect:'error'});
          if(!response.ok || !response.body)throw new Error();
          // Consume the source directly: Baileys' fetched.pipe currently loses source errors.
          let size=0;const chunks=[];
          for await(const chunk of response.body){size+=chunk.length;if(size>MAX_MEDIA+32){await response.body.cancel?.().catch(()=>{});throw new Error();}chunks.push(chunk);}
          const encrypted=Buffer.concat(chunks);if(encrypted.length<26)throw new Error();
          const {cipherKey,iv,macKey}=await library.getMediaKeys(content.mediaKey,raw.message.imageMessage?'image':raw.message.videoMessage?'video':'document');
          const ciphertext=encrypted.subarray(0,-10),mac=encrypted.subarray(-10);
          const expected=createHmac('sha256',macKey).update(iv).update(ciphertext).digest().subarray(0,10);
          if(!timingSafeEqual(mac,expected))throw new Error();
          const decipher=createDecipheriv('aes-256-cbc',cipherKey,iv);
          const bytes=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
          if(bytes.length!==r.size || sniffMedia(bytes)!==r.mime)throw new Error();
          if(content.fileSha256 && !timingSafeEqual(createHash('sha256').update(bytes).digest(),Buffer.from(content.fileSha256,typeof content.fileSha256==='string'?'base64':undefined)))throw new Error();
          // Policy/disconnect may have deleted the row while a download was running.
          if(!store.waMediaGet(id))throw new Error();
          store.waMediaCache(id,vault.seal(r.account_id,{id,bytes:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')}));
          return {bytes,mime:r.mime};
        } catch {throw new HttpError(410,'Média indisponible ou expiré sur WhatsApp.','media_unavailable');}
        finally {clearTimeout(timer);pending.delete(id);await agent.destroy();}
      })();pending.set(id,task);return task;
    },
    sent(accountId,chatJid,msgId,attachment) {
      if(!attachment)return;
      put(accountId,{chatJid,msgId,mime:attachment.mime,kind:attachment.kind,size:attachment.size},{bytes:attachment.bytes.toString('base64'),hash:attachment.hash});
    },
  };
}
