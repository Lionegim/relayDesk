import {replyId,validReaction} from './interactions.js';
// Brouillons locaux, réactions et réponses WhatsApp vers la discussion enregistrée.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest } from '../../http/errors.js';
import { readComposeInput } from '../../mail/input.js';
import { isDirectJid, groupJid, phoneOf, directJid } from './parse.js';

const CONFIRM_TTL_MS = 10 * 60000;
export const MAX_SEND = 4096; // caractères par message envoyé

// L'empreinte lie compte, génération du compte, discussion et texte exact.
const digestOf = (accountId, generation, chatJid, text, attachment=null, quote=null) => createHash('sha256')
  .update(`whatsapp\naccount:${accountId}\ngeneration:${generation}\nchat:${chatJid}\n`).update(text, 'utf8').update(attachment?`\nmedia:${attachment.id}:${attachment.hash}`:'').update(quote?`\nquote:${JSON.stringify(quote)}`:'').digest('hex');

export function createWhatsAppOutbox({ store, sync, media=null }) {
  const sending = new Set();
  const confirmations = new Map(); // empreinte -> { messageId, accountId, generation, expires }
  const sweep = () => { const now = Date.now(); for (const [d, c] of confirmations) if (c.expires < now) confirmations.delete(d); };
  sync.onForget(accountId => { for (const [d, c] of confirmations) if (c.accountId === accountId) confirmations.delete(d); });

  function read(input) {
    const parsed = readComposeInput(input);
    if (parsed.mode !== 'reply') throw badRequest('WhatsApp : seule la réponse dans la discussion est disponible.');
    return parsed;
  }
  // Discussion WhatsApp reçue (jamais un nouveau message) et son JID enregistré.
  function target(messageId) {
    const ctx = store.composeContext(messageId);
    if (!sync.isWhatsApp(ctx.accountId) || ctx.kind === 'new') throw badRequest('Ce message n’est pas une conversation WhatsApp.');
    if (!isDirectJid(ctx.threadId) && !groupJid(ctx.threadId)) throw new HttpError(409, 'Discussion WhatsApp invalide.', 'compose_unavailable');
    return { accountId: ctx.accountId, chatJid: ctx.threadId };
  }
  function messageKey(chatJid,m,sock) {
    const key={remoteJid:chatJid,id:m.msg_id ?? m.id,fromMe:!!(m.from_me ?? m.fromMe)};
    if(groupJid(chatJid)) {
      const participant=directJid(m.author_jid ?? m.participantJid) || (key.fromMe?directJid(sock.user?.lid || sock.user?.id):null);
      if(!participant)throw new HttpError(409,'L’auteur de ce message n’est pas disponible. Choisis un autre message.','quote_author_unavailable');
      key.participant=participant;
    }
    return key;
  }
  function checkSend(accountId, text, attachment) {
    if (!sync.permissions(accountId).includes('send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
    if (!text.trim() && !attachment) throw badRequest('Le message est vide.');
    if (text.length > MAX_SEND) throw badRequest(`Message trop long (${MAX_SEND} caractères au plus).`);
  }

  return {
    async react(messageId,input) {
      const {accountId,chatJid}=target(messageId);
      const emoji=input?.emoji;
      if(!validReaction(emoji))throw badRequest('Réaction invalide.');
      if(!sync.permissions(accountId).includes('send'))throw new HttpError(403,'La permission Envoi n’est pas accordée.','send_forbidden');
      const expectedGeneration=sync.generation(accountId),identity=store.accountIdentity(accountId);
      const targetId=replyId(input?.messageId);
      if(!targetId)throw badRequest('Message requis.');
      if(sending.has(messageId))throw new HttpError(409,'Une action est déjà en cours.','send_in_progress');
      sending.add(messageId);
      try{return await sync.serial(accountId,async()=>{
        if(!store.hasAccount(accountId) || expectedGeneration!==sync.generation(accountId) || identity!==store.accountIdentity(accountId))throw new HttpError(409,'La connexion a changé : recharge la discussion.','account_changed');
        const currentTarget=target(messageId);
        if(currentTarget.accountId!==accountId || currentTarget.chatJid!==chatJid)throw new HttpError(409,'La discussion a changé.','account_changed');
        if(!sync.permissions(accountId).includes('send'))throw new HttpError(403,'La permission Envoi n’est pas accordée.','send_forbidden');
        const m=store.waInteractionTarget(accountId,chatJid,targetId);
        const sock=sync.liveSocket(accountId);
        if(!sock)throw new HttpError(409,'WhatsApp n’est pas connecté.','whatsapp_offline');
        const generation=sync.generation(accountId),ts=Date.now(),key=messageKey(chatJid,m,sock);
        try{await sock.sendMessage(chatJid,{react:{text:emoji,key}});}
        catch{throw new HttpError(502,'Réaction WhatsApp incertaine : vérifie sur le téléphone avant de réessayer.','send_uncertain');}
        if(store.hasAccount(accountId) && generation===sync.generation(accountId))store.waApplyReaction(accountId,{chatJid,msgId:m.msg_id,actor:'me',emoji,ts});
        return {reacted:true};
      });}finally{sending.delete(messageId);}
    },
    // Brouillon local uniquement : WhatsApp n'a pas de brouillon partagé entre appareils.
    async saveDraft(messageId, input) {
      const { text } = read(input);
      const { accountId } = target(messageId);
      return sync.serial(accountId, () => {const replyTo=replyId(input?.replyTo);if(replyTo)store.waQuote(accountId,store.composeContext(messageId).threadId,replyTo,true);return store.saveDraft(messageId, text, { mode: 'reply',replyTo,expectedVersion:input?.baseVersion });});
    },

    async preview(messageId, input) {
      store.assertDraftVersion(messageId,input?.baseVersion);
      const { text } = read(input);
      const { accountId, chatJid } = target(messageId);
      const attachment=media?.draft(messageId,input.attachmentId);
      const quote=store.waQuote(accountId,chatJid,replyId(input?.replyTo),true);
      checkSend(accountId, text, attachment);
      const account = store.getAccount(accountId);
      const name = store.waChatName(accountId, chatJid);
      const phone = phoneOf(chatJid);
      const digest = digestOf(accountId, sync.generation(accountId), chatJid, text, attachment, quote);
      sweep();
      confirmations.set(digest, { messageId, accountId,draftVersion:store.assertDraftVersion(messageId), generation: sync.generation(accountId), expires: Date.now() + CONFIRM_TTL_MS });
      return {
        channel: 'whatsapp',
        from: account.address ? `${account.name} (${account.address})` : account.name,
        to: [groupJid(chatJid)?`Groupe · ${name || 'Groupe WhatsApp'}`:name && phone ? `${name} (${phone})` : name || phone || 'Contact WhatsApp'],
        ...(groupJid(chatJid)?{group:true}:{}),
        cc: [],
        subject: store.composeContext(messageId).subject, // interne : non affiché pour WhatsApp
        body: text,
        ...(quote?{quote}:{}),
        ...(attachment?{attachment:{id:attachment.id,url:attachment.url,mime:attachment.mime,kind:attachment.kind,size:attachment.size}}:{}),
        digest,
      };
    },

    async send(messageId, input) {
      const { text } = read(input);
      const digest = input?.digest;
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw badRequest('Empreinte de validation manquante.');
      const { accountId, chatJid } = target(messageId);
      const attachment=media?.draft(messageId,input.attachmentId);
      checkSend(accountId, text, attachment);
      if (sending.has(messageId)) throw new HttpError(409, 'Un envoi est déjà en cours pour ce message.', 'send_in_progress');
      sending.add(messageId);
      try {
        return await sync.serial(accountId, async () => {
          checkSend(accountId,text,attachment);
          const generation = sync.generation(accountId);
          const quote=store.waQuote(accountId,chatJid,replyId(input?.replyTo),true);
          const actual = digestOf(accountId, generation, chatJid, text, attachment, quote);
          if (!timingSafeEqual(Buffer.from(actual), Buffer.from(digest))) {
            throw new HttpError(409, 'Le message a changé depuis sa validation : vérifie-le à nouveau avant d’envoyer.', 'digest_mismatch');
          }
          sweep();
          const confirmation = confirmations.get(digest);
          if (!confirmation || confirmation.messageId !== messageId || confirmation.accountId !== accountId || confirmation.generation !== generation) {
            throw new HttpError(409, 'Validation absente, expirée ou déjà utilisée : vérifie le message à nouveau.', 'confirmation_invalid');
          }
          store.assertDraftVersion(messageId,confirmation.draftVersion);
          if(input.direct===true && store.requiresDraftReview(messageId))throw new HttpError(409,'Ce brouillon utilise une proposition IA : valide son aperçu exact.','preview_required');
          // Hors ligne : rien n'est tenté, la validation reste utilisable.
          const sock = sync.liveSocket(accountId);
          if (!sock) throw new HttpError(409, 'WhatsApp n’est pas connecté : réessaie quand le compte est en ligne.', 'whatsapp_offline');
          // Consommée avant l'appel : ni requête concurrente, ni rejeu, ni relance automatique.
          confirmations.delete(digest);
          let sent;
          const memoryTicket=store.getReplyMemory(messageId,{internal:true});
          const sendStartedAt=Date.now();
          const quoted=quote?{key:messageKey(chatJid,quote,sock),message:{conversation:quote.body}}:null;
          try {
            const content=attachment ? (attachment.mime==='video/mp4' ? {video:attachment.bytes,mimetype:attachment.mime,gifPlayback:true,caption:text} : {image:attachment.bytes,mimetype:attachment.mime,caption:text}) : { text };
            sent = quoted?await sock.sendMessage(chatJid,content,{quoted}):await sock.sendMessage(chatJid,content);
          } catch {
            // Issue inconnue (le message a pu partir) : nouvelle vérification exigée, jamais de nouvel essai automatique.
            throw new HttpError(502, 'Envoi WhatsApp incertain : vérifie la discussion sur le téléphone avant de renvoyer.', 'send_uncertain');
          }
          for (const [key, c] of confirmations) if (c.messageId === messageId && c.accountId === accountId) confirmations.delete(key);
          const msgId = typeof sent?.key?.id === 'string' && sent.key.id ? sent.key.id : `relay-${digest.slice(0, 24)}`;
          // A policy change or relink may remove the thread while delivery is in flight.
          // Successful delivery must never recreate that purged history.
          if (store.hasAccount(accountId) && generation===sync.generation(accountId) && store.threadState(accountId,chatJid)?.id===messageId && store.assertDraftVersion(messageId)===confirmation.draftVersion) {
            store.rememberReply(messageId,text,{ticket:memoryTicket,at:sendStartedAt});
            store.waAddMessages(accountId, [{ chatJid, msgId, fromMe: true, ts: sendStartedAt, replyTo:quote?.id, participantJid:groupJid(chatJid)?directJid(sent?.key?.participant || sock.user?.lid || sock.user?.id):null, text:text || (attachment?.kind==='gif'?'GIF':'Photo') }]);
            try {media?.sent(accountId,chatJid,msgId,attachment);}catch { /* Delivery succeeded; never suggest a retry because caching failed. */ }
            store.clearDraft(messageId);
            sync.rebuild(accountId, chatJid);
          }
          return { sent: true, draftRemoved: true };
        });
      } finally {
        sending.delete(messageId);
      }
    },
  };
}
