import {badRequest,HttpError} from '../../http/errors.js';
import {directJid,groupJid,phoneOf,contactName} from './parse.js';
export function readMentions(value,text) {
 if(value==null)return [];
 if(!Array.isArray(value) || value.length>50)throw badRequest('Mentions invalides (50 maximum).');
 let end=0;
 return value.map(m=>{
  const jid=directJid(m?.jid),start=m?.start,stop=m?.end;
  if(!jid || jid!==m.jid || !Number.isInteger(start) || !Number.isInteger(stop) || start<end || stop<=start || stop>text.length || text.slice(start,stop)!==`@${jid.split('@')[0]}` || /[\p{L}\p{N}_@]/u.test(text[start-1] || '') || /[\p{L}\p{N}_]/u.test(text[stop] || ''))throw badRequest('Une mention a changé. Sélectionne à nouveau la personne.');
  end=stop;return {jid,start,end:stop};
 });
}
export function createWhatsAppMentions({store,sync}) {
 const cache=new Map();
 sync.onForget(account=>{for(const [key,row] of cache)if(row.account===account)cache.delete(key);});
 async function participants(messageId,{fresh=false}={}) {
  const ctx=store.composeContext(messageId),account=ctx.accountId,chat=ctx.threadId;
  if(!sync.isWhatsApp(account) || !groupJid(chat) || ctx.kind==='new')throw badRequest('Choisis un groupe WhatsApp.');
  if(!sync.permissions(account).includes('read'))throw new HttpError(403,'Le compte doit être connecté.','read_forbidden');
  const scope=store.waConversationScope(messageId),identity=store.accountIdentity(account),generation=sync.generation(account),key=`${identity}:${generation}:${chat}:${scope}`;
  const old=cache.get(key);if(!fresh && old?.expires>Date.now())return old.participants;
  const sock=sync.liveSocket(account);if(!sock?.groupMetadata)throw new HttpError(409,'Les participants sont indisponibles : reconnecte WhatsApp.','whatsapp_offline');
  let timer,metadata;
  try{metadata=await Promise.race([sock.groupMetadata(chat),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),8000);})]);}
  catch{throw new HttpError(502,'Impossible de charger les participants. Réessaie dans un instant.','participants_unavailable');}
  finally{clearTimeout(timer);}
  const current=store.hasAccount(account) && store.threadState(account,chat)?.id===messageId && store.waConversationScope(messageId)===scope && store.accountIdentity(account)===identity && sync.generation(account)===generation;
  if(!current || store.waEphemeralChats(account).includes(chat))throw new HttpError(409,'La discussion ou la connexion a changé.','account_changed');
  if(metadata?.id!==chat || !Array.isArray(metadata.participants) || metadata.participants.length>5000)throw new HttpError(502,'Liste des participants invalide.','participants_unavailable');
  const rows=new Map();
  for(const p of metadata.participants) {
   const jid=directJid(p.id);if(!jid)continue;
   const phone=phoneOf(directJid(p.phoneNumber)) || phoneOf(jid);
   const name=store.waChatName(account,jid) || (directJid(p.phoneNumber) && store.waChatName(account,directJid(p.phoneNumber))) || contactName(p) || phone || `Participant · ${jid.split('@')[0].slice(-6)}`;
   rows.set(jid,{jid,name,phone,token:`@${jid.split('@')[0]}`});
  }
  const participants=[...rows.values()].sort((a,b)=>a.name.localeCompare(b.name,'fr'));
  if(cache.size>=100)cache.delete(cache.keys().next().value);
  cache.set(key,{account,participants,expires:Date.now()+60000});return participants;
 }
 return {
  participants,
  async resolve(messageId,input,text,{fresh=true}={}) {
   const selected=readMentions(input,text);if(!selected.length)return [];
   const members=new Map((await participants(messageId,{fresh})).map(p=>[p.jid,p]));
   return selected.map(m=>{const member=members.get(m.jid);if(!member)throw new HttpError(409,'Une personne mentionnée ne fait plus partie de ce groupe. Retire ou remplace sa mention.','mention_unavailable');return {...m,name:member.name,phone:member.phone};});
  }
 };
}
