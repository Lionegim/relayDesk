// Filtrage des messages WhatsApp : discussions individuelles et groupes, texte seulement.
// Statuts, diffusions, chaînes, messages éphémères et vue unique restent exclus.
import { createHash } from 'node:crypto';
import { initialsOf } from '../gmail/parse.js';

export const MAX_TEXT = 8000; // caractères conservés par message importé

// JID d'une conversation directe, sans suffixe d'appareil : « 33612345678@s.whatsapp.net » ou « 1234…@lid ».
export function directJid(jid) {
  const m = typeof jid === 'string' && /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.exec(jid);
  if (!m) return null;
  return `${m[1]}@${m[2] === 'lid' ? 'lid' : 's.whatsapp.net'}`;
}
export const isDirectJid = jid => directJid(jid) !== null && directJid(jid) === jid;
export const groupJid = jid => typeof jid === 'string' && /^\d{5,30}(?:-\d{1,20})?@g\.us$/.test(jid) ? jid : null;
export const chatJid = jid => directJid(jid) || groupJid(jid);

// Numéro affichable, seulement pour un JID de numéro (un JID @lid n'est pas un numéro de téléphone).
export const phoneOf = jid => (/^(\d{5,20})@s\.whatsapp\.net$/.exec(jid || '') || [])[1] ? `+${jid.split('@')[0]}` : null;

const WRAPPERS_REFUSED = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];

// Texte d'un message, ou null s'il n'est pas importable.
export function textOf(message) {
  if (!message || typeof message !== 'object') return null;
  if (WRAPPERS_REFUSED.some(k => message[k]) || [message.imageMessage,message.videoMessage,message.documentMessage].some(v=>v?.viewOnce || Number(v?.contextInfo?.expiration)>0)) return null;
  const ctx = message.extendedTextMessage?.contextInfo || message.imageMessage?.contextInfo || message.videoMessage?.contextInfo || message.documentMessage?.contextInfo;
  if (ctx && Number(ctx.expiration) > 0) return null; // discussion en mode messages éphémères
  let text = mediaOf(message) ? (message.imageMessage?.caption ?? message.videoMessage?.caption ?? message.documentMessage?.caption ?? null) : null;
  if (typeof message.conversation === 'string') text = message.conversation;
  else if (typeof message.extendedTextMessage?.text === 'string') text = message.extendedTextMessage.text;
  text = text?.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT) : null;
}

export function mediaOf(message) {
  if(!message || WRAPPERS_REFUSED.some(k=>message[k]))return null;
  const item=message.imageMessage || (message.videoMessage?.gifPlayback?message.videoMessage:null) || (message.documentMessage?.mimetype==='image/gif'?message.documentMessage:null);
  if(!item || item.viewOnce || Number(item.contextInfo?.expiration)>0)return null;
  const mime=message.videoMessage?'video/mp4':item.mimetype;
  if(!['image/jpeg','image/png','image/webp','image/gif','video/mp4'].includes(mime))return null;
  const size=Number(item.fileLength?.toNumber?.() ?? item.fileLength ?? 0);
  if(!Number.isSafeInteger(size) || size<=0 || size>10*1024*1024)return null;
  return {mime,size,kind:mime==='image/gif'||mime==='video/mp4'?'gif':'image'};
}

// Horodatage en millisecondes (nombre, chaîne ou Long de protobufjs).
export function tsOf(v) {
  const n = v && typeof v === 'object' ? (typeof v.toNumber === 'function' ? v.toNumber() : Number(v.low)) : Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

// WAMessage → { chatJid, msgId, fromMe, ts, text, pushName } ou null.
export function parseMessage(m, { since = 0 } = {}) {
  const key = m?.key;
  const conversation = chatJid(key?.remoteJid);
  if (!conversation || typeof key.id !== 'string' || !key.id || key.id.length > 128) return null;
  if (m.messageStubType || m.broadcast) return null;
  const ts = tsOf(m.messageTimestamp);
  if (!ts || ts < since) return null;
  const media = mediaOf(m.message);
  const text = textOf(m.message) || (media ? (media.kind==='gif'?'GIF':'Photo') : null);
  if (!text) return null;
  const pushName = !key.fromMe && typeof m.pushName === 'string' ? m.pushName.trim().slice(0, 80) : '';
  const participantJid = groupJid(conversation) ? directJid(key.participant || m.participant) : null;
  const senderName = groupJid(conversation) && !key.fromMe ? pushName || phoneOf(participantJid) || 'Participant' : null;
  return { chatJid: conversation, msgId: key.id, fromMe: !!key.fromMe, ts, text, pushName, participantJid, senderName, ...(media?{media}:{} ) };
}

// Nom d'un contact WhatsApp (carnet, nom public, nom vérifié).
export const contactName = c => [c?.name, c?.notify, c?.verifiedName].find(v => typeof v === 'string' && v.trim())?.trim().slice(0, 80) || null;

export const dayLabel = (ts, now = Date.now()) => {
  const d = new Date(ts), today = new Date(now);
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days <= 0) return 'Aujourd’hui';
  if (days === 1) return 'Hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};

export const contactId = (accountId, chatJid) => `wa${accountId}_${createHash('sha256').update(chatJid).digest('hex').slice(0, 16)}`;

// Une ligne de la boîte par discussion : dernier message en corps, précédents dans `trail` (du plus récent au plus ancien).
// `state` : état local existant (lu, drapeau, archive), conservé ; un nouveau message reçu rend le fil non lu et visible.
export function chatToRecord(chatJid, msgs, { name, state, incoming = false, trailMax = 50 }) {
  const last = msgs.at(-1);
  const group = !!groupJid(chatJid);
  const who = name || phoneOf(chatJid) || (group ? 'Groupe WhatsApp' : 'Contact WhatsApp');
  const label = m => (m.fromMe ? 'Moi' : group ? m.senderName || phoneOf(m.participantJid) || 'Participant' : who);
  return {
    externalId: chatJid,
    // L'auteur du dernier message reste exact (l'assistant IA lit `from` comme auteur du corps).
    from: last.fromMe ? `Moi (à ${who})` : label(last), initials: initialsOf(who), handle: phoneOf(chatJid) || '',
    sortAt: last.ts,
    unread: incoming || (state?.unread ?? false),
    flagged: state?.flagged ?? false,
    archived: incoming ? false : (state?.archived ?? false),
    folderId: state?.folderId ?? null,
    label: 'Perso', triage: 'Message WhatsApp : aucune action automatique.',
    subject: `WhatsApp · ${who}`,
    preview: last.text.slice(0, 200),
    body: last.text,
    trail: msgs.slice(0, -1).reverse().slice(0, trailMax).map(m => ({ from: label(m), initials: initialsOf(label(m)), fromMe: m.fromMe, at: m.ts, body: m.text })),
    count: msgs.length,
  };
}
