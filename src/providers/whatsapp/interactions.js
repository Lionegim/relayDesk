import {badRequest, HttpError} from '../../http/errors.js';
import {chatJid,directJid,groupJid,phoneOf} from './parse.js';
const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'});
export function validReaction(emoji) {
 return typeof emoji==='string' && (emoji==='' || (emoji.length<=32 && [...graphemes.segment(emoji)].length===1 && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e30-9#*]+$/u.test(emoji) && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3/u.test(emoji)));
}
export function replyId(value) {
 if(value==null)return null;
 if(typeof value!=='string' || !value || value.length>128 || /[\u0000-\u001f]/.test(value))throw badRequest('Message cité invalide.');
 return value;
}
export function reactionEvent(key,reaction) {
 const chat=chatJid(key?.remoteJid),id=key?.id;
 const actor=reaction?.key?.fromMe?'me':directJid(reaction?.key?.participant || reaction?.key?.remoteJid);
 const emoji=reaction?.text ?? '';
 const ts=Number(reaction?.senderTimestampMs?.toNumber?.() ?? reaction?.senderTimestampMs ?? Date.now());
 if(!chat || !actor || typeof id!=='string' || !id || id.length>128 || !validReaction(emoji) || !Number.isSafeInteger(ts) || ts<0)return null;
 return {chatJid:chat,msgId:id,actor,emoji,ts};
}
export function createWhatsAppInteractions(db,changed) {
 const get=(account,chat,id)=>db.prepare('SELECT * FROM whatsapp_messages WHERE account_id=? AND chat_jid=? AND msg_id=?').get(account,chat,id);
 const name=(account,chat,m)=>m.from_me?'Vous':(m.author_jid && db.prepare('SELECT name FROM whatsapp_chats WHERE account_id=? AND chat_jid=?').get(account,m.author_jid)?.name) || m.sender_name || (groupJid(chat)?phoneOf(m.author_jid) || 'Participant':db.prepare('SELECT name FROM whatsapp_chats WHERE account_id=? AND chat_jid=?').get(account,chat)?.name || 'Contact WhatsApp');
 const quote=(account,chat,id,required=false)=>{
  if(!id)return null;const m=get(account,chat,id);
  if(!m){if(required)throw new HttpError(409,'Le message cité n’est plus disponible. Choisis un autre message.','quote_unavailable');return {id,unavailable:true,author:'Message indisponible',body:'Le message cité n’est pas dans l’historique conservé.'};}
  if(required && groupJid(chat) && !m.from_me && !directJid(m.author_jid))throw new HttpError(409,'L’auteur de ce message n’est pas disponible. Choisis un autre message.','quote_author_unavailable');
  return {id:m.msg_id,...(groupJid(chat)?{participantJid:directJid(m.author_jid)}:{}),fromMe:!!m.from_me,author:name(account,chat,m),body:m.text,at:m.ts};
 };
 return {
  waInteractionTarget(account,chat,id){const m=get(account,chat,replyId(id));if(!m)throw new HttpError(409,'Ce message n’est plus disponible.','quote_unavailable');return m;},
  waQuote:quote,
  waMessageDetails(account,chat,m){return {mentions:JSON.parse(m.mentions || '[]').map(v=>({...v,name:v.name || db.prepare('SELECT name FROM whatsapp_chats WHERE account_id=? AND chat_jid=?').get(account,v.jid)?.name || phoneOf(v.jid) || 'Participant'})),waId:m.msg_id,canInteract:!groupJid(chat) || !!m.from_me || !!directJid(m.author_jid),quote:quote(account,chat,m.reply_to),reactions:db.prepare("SELECT emoji,count(*) count,MAX(actor='me') mine FROM whatsapp_reactions WHERE account_id=? AND chat_jid=? AND msg_id=? AND emoji<>'' GROUP BY emoji ORDER BY MIN(ts),emoji").all(account,chat,m.msg_id).map(r=>({...r,mine:!!r.mine}))};},
  waApplyReaction(account,event){
   if(!event || !get(account,event.chatJid,event.msgId))return false;
   const {chatJid:chat,msgId:id,actor,emoji,ts}=event;
   const old=db.prepare('SELECT ts,emoji FROM whatsapp_reactions WHERE account_id=? AND chat_jid=? AND msg_id=? AND actor=?').get(account,chat,id,actor);
   if(old && (old.ts>ts || (old.ts===ts && old.emoji===emoji)))return false;
   db.prepare('INSERT INTO whatsapp_reactions VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,chat_jid,msg_id,actor) DO UPDATE SET emoji=excluded.emoji,ts=excluded.ts').run(account,chat,id,actor,emoji,ts);
   db.prepare('UPDATE messages SET interaction_version=interaction_version+1 WHERE account_id=? AND external_id=?').run(account,chat);changed();return true;
  }
 };
}
