// Brouillons (locaux) et envoi WhatsApp. V1 : réponse texte seulement, toujours vers le JID enregistré de la
// discussion ; ni le navigateur ni l'assistant ne choisissent le destinataire.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest } from '../../http/errors.js';
import { readComposeInput } from '../../mail/input.js';
import { isDirectJid, groupJid, phoneOf } from './parse.js';

const CONFIRM_TTL_MS = 10 * 60000;
export const MAX_SEND = 4096; // caractères par message envoyé

// L'empreinte lie compte, génération du compte, discussion et texte exact.
const digestOf = (accountId, generation, chatJid, text) => createHash('sha256')
  .update(`whatsapp\naccount:${accountId}\ngeneration:${generation}\nchat:${chatJid}\n`).update(text, 'utf8').digest('hex');

export function createWhatsAppOutbox({ store, sync }) {
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
  function target(messageId, allowGroup = false) {
    const ctx = store.composeContext(messageId);
    if (!sync.isWhatsApp(ctx.accountId) || ctx.kind === 'new') throw badRequest('Ce message n’est pas une conversation WhatsApp.');
    if (groupJid(ctx.threadId) && !allowGroup) throw new HttpError(409, 'Groupes : lecture et analyse disponibles ; envoi non activé.', 'compose_unavailable');
    if (!isDirectJid(ctx.threadId) && !(allowGroup && groupJid(ctx.threadId))) throw new HttpError(409, 'Discussion WhatsApp invalide.', 'compose_unavailable');
    return { accountId: ctx.accountId, chatJid: ctx.threadId };
  }
  function checkSend(accountId, text) {
    if (!sync.permissions(accountId).includes('send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
    if (!text.trim()) throw badRequest('Le message est vide.');
    if (text.length > MAX_SEND) throw badRequest(`Message trop long (${MAX_SEND} caractères au plus).`);
  }

  return {
    // Brouillon local uniquement : WhatsApp n'a pas de brouillon partagé entre appareils.
    async saveDraft(messageId, input) {
      const { text } = read(input);
      const { accountId } = target(messageId, true);
      return sync.serial(accountId, () => store.saveDraft(messageId, text, { mode: 'reply' }));
    },

    async preview(messageId, input) {
      const { text } = read(input);
      const { accountId, chatJid } = target(messageId);
      checkSend(accountId, text);
      const account = store.getAccount(accountId);
      const name = store.waChatName(accountId, chatJid);
      const phone = phoneOf(chatJid);
      const digest = digestOf(accountId, sync.generation(accountId), chatJid, text);
      sweep();
      confirmations.set(digest, { messageId, accountId, generation: sync.generation(accountId), expires: Date.now() + CONFIRM_TTL_MS });
      return {
        channel: 'whatsapp',
        from: account.address ? `${account.name} (${account.address})` : account.name,
        to: [name && phone ? `${name} (${phone})` : name || phone || 'Contact WhatsApp'],
        cc: [],
        subject: store.composeContext(messageId).subject, // interne : non affiché pour WhatsApp
        body: text,
        digest,
      };
    },

    async send(messageId, input) {
      const { text } = read(input);
      const digest = input?.digest;
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw badRequest('Empreinte de validation manquante.');
      const { accountId, chatJid } = target(messageId);
      checkSend(accountId, text);
      if (sending.has(messageId)) throw new HttpError(409, 'Un envoi est déjà en cours pour ce message.', 'send_in_progress');
      sending.add(messageId);
      try {
        return await sync.serial(accountId, async () => {
          const generation = sync.generation(accountId);
          const actual = digestOf(accountId, generation, chatJid, text);
          if (!timingSafeEqual(Buffer.from(actual), Buffer.from(digest))) {
            throw new HttpError(409, 'Le message a changé depuis sa validation : vérifie-le à nouveau avant d’envoyer.', 'digest_mismatch');
          }
          sweep();
          const confirmation = confirmations.get(digest);
          if (!confirmation || confirmation.messageId !== messageId || confirmation.accountId !== accountId || confirmation.generation !== generation) {
            throw new HttpError(409, 'Validation absente, expirée ou déjà utilisée : vérifie le message à nouveau.', 'confirmation_invalid');
          }
          // Hors ligne : rien n'est tenté, la validation reste utilisable.
          const sock = sync.liveSocket(accountId);
          if (!sock) throw new HttpError(409, 'WhatsApp n’est pas connecté : réessaie quand le compte est en ligne.', 'whatsapp_offline');
          // Consommée avant l'appel : ni requête concurrente, ni rejeu, ni relance automatique.
          confirmations.delete(digest);
          let sent;
          try {
            sent = await sock.sendMessage(chatJid, { text });
          } catch {
            // Issue inconnue (le message a pu partir) : nouvelle vérification exigée, jamais de nouvel essai automatique.
            throw new HttpError(502, 'Envoi WhatsApp incertain : vérifie la discussion sur le téléphone avant de renvoyer.', 'send_uncertain');
          }
          for (const [key, c] of confirmations) if (c.messageId === messageId && c.accountId === accountId) confirmations.delete(key);
          const msgId = typeof sent?.key?.id === 'string' && sent.key.id ? sent.key.id : `relay-${digest.slice(0, 24)}`;
          if (store.hasAccount(accountId)) {
            store.waAddMessages(accountId, [{ chatJid, msgId, fromMe: true, ts: Date.now(), text }]);
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
