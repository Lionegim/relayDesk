import {Agent,fetch as fetchDefault} from 'undici';
import {HttpError,notFound} from '../../http/errors.js';
import {sniffMedia} from './media.js';
import {directJid,groupJid} from './parse.js';
// Ephemeral private cache: no signed CDN URL or profile photo is persisted or sent to the UI.
export function createWhatsAppAvatars({store,sync,mentions,fetchPhoto=fetchDefault,timeoutMs=8000,ttlMs=6*3600000,missingMs=15*60000}) {
 const cache=new Map(),pending=new Map();let bytesUsed=0,active=0;const queue=[];
 function remove(key){const old=cache.get(key);bytesUsed-=old?.photo?.bytes.length || 0;cache.delete(key);}
 function put(key,row){remove(key);while(cache.size>=500 || bytesUsed+(row.photo?.bytes.length || 0)>16*1024*1024)remove(cache.keys().next().value);cache.set(key,row);bytesUsed+=row.photo?.bytes.length || 0;}
 sync.onForget(account=>{for(const [key,row] of cache)if(row.account===account)remove(key);});
 async function slot(){if(active>=4){if(queue.length>=200)throw new HttpError(429,'Chargement des photos en cours.','avatar_busy');await new Promise(resolve=>queue.push(resolve));}else active++;}
 function release(){const next=queue.shift();if(next)next();else active--;}
 async function download(account,jid) {
  let timer,agent;
  try {
   const sock=sync.liveSocket(account);if(!sock?.profilePictureUrl)throw new Error();
   const urlValue=await Promise.race([sock.profilePictureUrl(jid,'preview',timeoutMs),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error()),timeoutMs);})]);clearTimeout(timer);
   const url=new URL(urlValue);if(url.protocol!=='https:' || !/(^|\.)whatsapp\.(net|com)$/.test(url.hostname) || url.port || url.username || url.password)throw new Error();
   agent=new Agent({connect:{timeout:timeoutMs},headersTimeout:timeoutMs,bodyTimeout:timeoutMs});
   timer=setTimeout(()=>{agent.destroy(new Error('avatar timeout')).catch(()=>{});},timeoutMs);
   const response=await fetchPhoto(url,{dispatcher:agent,signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
   if(!response.ok || !response.body)throw new Error();
   if(Number(response.headers.get('content-length'))>1024*1024){await response.body.cancel();throw new Error();}
   let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(Buffer.from(chunk));}
   const bytes=Buffer.concat(chunks),mime=sniffMedia(bytes);if(!['image/jpeg','image/png','image/webp'].includes(mime))throw new Error();
   return {bytes,mime};
  }catch{return null;}finally{clearTimeout(timer);if(agent)await agent.destroy();}
 }
 return {async get(kind,id,scope,participant=null) {
  const source=store.waAvatarTarget(kind,id);if(!scope || source.scope!==scope)throw notFound();
  const {account,jid:chat,identity}=source,generation=sync.generation(account);
  const current=()=>{try{const now=store.waAvatarTarget(kind,id);return now.scope===scope && now.account===account && now.identity===identity && now.jid===chat && sync.generation(account)===generation && sync.permissions(account).includes('read') && !store.waEphemeralChats(account).includes(chat);}catch{return false;}};
  if(!current())throw notFound();
  let jid=chat;
  if(participant) {
   if(kind!=='messages' || !groupJid(chat) || directJid(participant)!==participant)throw notFound();
   const members=await mentions.participants(id);if(!current() || !members.some(p=>p.jid===participant))throw notFound();jid=participant;
  }
  const key=JSON.stringify([identity,generation,jid]);let old=cache.get(key);
  if(old?.expires<=Date.now()){remove(key);old=null;}
  let photo=old?.photo;
  if(!old) {
   if(!pending.has(key)) {
    const task=(async()=>{await slot();try{if(!current())throw notFound();const photo=await download(account,jid);if(!current())throw notFound();put(key,{account,photo,expires:Date.now()+(photo?ttlMs:missingMs)});return photo;}finally{release();}})();
    pending.set(key,task);task.finally(()=>pending.delete(key)).catch(()=>{});
   }
   photo=await pending.get(key);
  }
  if(!current() || !photo)throw notFound('Photo indisponible.');
  return photo;
 }};
}
