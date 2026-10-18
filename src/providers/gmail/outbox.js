// Lots C et D : brouillons et envoi Gmail. Les messages sont construits côté serveur à partir des en-têtes stockés du fil ;
// le navigateur n'envoie que le texte, le mode et, pour un transfert, les destinataires.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest } from '../../http/errors.js';
import { buildMessage, envelope, forwardBody, formatAddress, toRaw, MimeError } from '../../mail/mime.js';
import { newEnvelope } from '../../mail/envelope.js';
import { readComposeInput } from '../../mail/input.js';
export { readComposeInput } from '../../mail/input.js';
import { replyMeta } from './parse.js';

const CONFIRM_TTL_MS = 10 * 60000;

// L'empreinte couvre le message exact et le fil Gmail visé.
const digestOf = (mime, threadId) => createHash('sha256').update(`thread:${threadId || ''}\n`).update(mime, 'utf8').digest('hex');


const mimeErrors = fn => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MimeError) throw badRequest(e.message);
    throw e;
  }
};

export function createGmailOutbox({ store, sync, ownerName = '' }) {
  const sending = new Set();
  // Validations émises par l'aperçu : usage unique, liées au message, au compte et (via l'empreinte) au fil.
  const confirmations = new Map(); // empreinte -> { messageId, accountId, expires }
  const sweep = () => { const now = Date.now(); for (const [d, c] of confirmations) if (c.expires < now) confirmations.delete(d); };
  const isGmail = accountId => accountId != null && store.hasAccount(accountId) && store.getAccount(accountId).svc === 'gmail';
  const can = (accountId, perm) => isGmail(accountId) && sync.permissions(accountId).includes(perm);

  // Message exact (MIME) pour ce fil, ce mode et ce texte.
  function compose(messageId, { text, mode, to, cc, subject }) {
    const ctx = store.composeContext(messageId);
    if ((ctx.kind === 'new') !== (mode === 'new')) throw badRequest('Mode incompatible avec ce message');
    if (mode === 'new') {
      const account = store.getAccount(ctx.accountId);
      if (!account.address) throw new HttpError(409, 'Adresse du compte inconnue.', 'compose_unavailable');
      const own = { name: ownerName, email: account.address };
      return mimeErrors(() => {
        const env = newEnvelope({ to, cc, subject });
        const mime = buildMessage({ from: own, ...env, body: text });
        return { ctx, own, env, body: text, mime, threadId: undefined };
      });
    }
    if (!ctx.reply) throw new HttpError(409, 'Les en-têtes de ce fil ne sont pas encore importés : synchronise le compte puis réessaie.', 'compose_unavailable');
    const account = store.getAccount(ctx.accountId);
    if (!account.address) throw new HttpError(409, 'Adresse du compte inconnue : reconnecte le compte.', 'compose_unavailable');
    const own = { name: ownerName, email: account.address };
    const original = { ...ctx.reply, subject: ctx.subject, body: ctx.body, date: ctx.reply.at ? new Date(ctx.reply.at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '' };
    return mimeErrors(() => {
      const env = envelope({ mode, own, original, forwardTo: to || '' });
      const body = mode === 'forward' ? forwardBody(text, original) : text;
      const mime = buildMessage({ from: own, ...env, body });
      return { ctx, own, env, body, mime, threadId: mode === 'forward' ? undefined : ctx.threadId };
    });
  }

  // Fils importés avant le lot C : en-têtes récupérés à la demande dans Gmail.
  async function ensureReply(gmail, messageId) {
    const ctx = store.composeContext(messageId);
    if (ctx.kind === 'new' || ctx.reply || !ctx.threadId) return;
    let thread;
    try {
      thread = await gmail.getThread(ctx.threadId);
    } catch (e) {
      if (e.code === 'not_found') throw new HttpError(409, 'Ce fil n’existe plus dans Gmail.', 'compose_unavailable');
      throw e;
    }
    const reply = replyMeta(thread);
    if (reply) store.setReplyMeta(messageId, reply);
  }

  return {
    can,
    compose,
    ensureReply,

    // Enregistre le brouillon : dans Gmail si le compte a la permission, sinon localement seulement.
    async saveDraft(messageId, input) {
      const parsed = readComposeInput(input);
      const { text, mode, to, cc, subject } = parsed;
      const { accountId } = store.composeContext(messageId);
      const local = () => store.saveDraft(messageId, text, { mode, to, cc, subject });
      if (!isGmail(accountId)) return local();
      // Toutes les sauvegardes d'un compte Gmail passent par sa file, y compris l'enregistrement local :
      // une écriture Gmail plus ancienne encore en cours ne peut pas écraser un brouillon plus récent.
      // Un transfert sans destinataire valide reste local jusqu'à ce qu'une adresse soit saisie.
      if (!can(accountId, 'drafts') || (['forward', 'new'].includes(mode) && !String(to).includes('@'))) return sync.queue(accountId, local);
      return sync.exclusive(accountId, async ({ gmail }) => {
        await ensureReply(gmail, messageId);
        const { mime, threadId, ctx } = compose(messageId, parsed);
        const message = { raw: toRaw(mime), ...(threadId ? { threadId } : {}) };
        let draftId = ctx.draftExternalId;
        if (draftId) {
          try {
            await gmail.put(`drafts/${encodeURIComponent(draftId)}`, { id: draftId, message });
          } catch (e) {
            if (e.code !== 'not_found') throw e;
            draftId = null; // supprimé dans Gmail entre-temps : on en recrée un
          }
        }
        if (!draftId) draftId = (await gmail.post('drafts', { message })).id;
        return store.saveDraft(messageId, text, { mode, to, cc, subject, externalId: draftId, synced: true });
      });
    },

    // Lot D, étape 1 : construit le message final et renvoie son contenu exact et son empreinte SHA-256.
    async preview(messageId, input) {
      const parsed = readComposeInput(input);
      const { text, mode, to, cc, subject } = parsed;
      const { accountId } = store.composeContext(messageId);
      if (!can(accountId, 'send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
      if (!text.trim()) throw badRequest('Le message est vide.');
      return sync.exclusive(accountId, async ({ gmail }) => {
        await ensureReply(gmail, messageId);
        const { own, env, body, mime, threadId } = compose(messageId, parsed);
        const digest = digestOf(mime, threadId);
        sweep();
        confirmations.set(digest, { messageId, accountId, generation: sync.generation(accountId), expires: Date.now() + CONFIRM_TTL_MS });
        return {
          from: formatAddress(own), to: env.to.map(formatAddress), cc: env.cc.map(formatAddress),
          subject: env.subject, body, digest,
        };
      });
    },

    // Lot D, étape 2 : reconstruit le message et n'envoie que si son empreinte est celle qui a été validée.
    async send(messageId, input) {
      const parsed = readComposeInput(input);
      const { text, mode, to, cc, subject } = parsed;
      const digest = input?.digest;
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw badRequest('Empreinte de validation manquante.');
      const { accountId } = store.composeContext(messageId);
      if (!can(accountId, 'send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
      if (sending.has(messageId)) throw new HttpError(409, 'Un envoi est déjà en cours pour ce message.', 'send_in_progress');
      sending.add(messageId);
      let result;
      try {
        await sync.exclusive(accountId, async ({ gmail }) => {
          await ensureReply(gmail, messageId);
          const { mime, threadId, ctx } = compose(messageId, parsed);
          const actual = digestOf(mime, threadId);
          if (!timingSafeEqual(Buffer.from(actual), Buffer.from(digest))) {
            throw new HttpError(409, 'Le message a changé depuis sa validation : vérifie-le à nouveau avant d’envoyer.', 'digest_mismatch');
          }
          sweep();
          const confirmation = confirmations.get(digest);
          // La génération exclut une validation émise avant une déconnexion, même si compte et message ont été recréés
          // avec les mêmes identifiants.
          if (!confirmation || confirmation.messageId !== messageId || confirmation.accountId !== accountId
            || confirmation.generation !== sync.generation(accountId)) {
            throw new HttpError(409, 'Validation absente, expirée ou déjà utilisée : vérifie le message à nouveau.', 'confirmation_invalid');
          }
          // Consommée avant l'appel : une requête concurrente ou rejouée ne peut pas envoyer une seconde fois.
          confirmations.delete(digest);
          try {
            // Toujours le MIME validé lui-même : jamais le contenu d'un brouillon Gmail (qui a pu être modifié ailleurs).
            await gmail.post('messages/send', { raw: toRaw(mime), ...(threadId ? { threadId } : {}) });
          } catch (e) {
            // Refus net de Gmail (aucun envoi) : la validation redevient utilisable pour un nouvel essai.
            // Une erreur réseau ou 5xx ne prouve pas l'absence d'envoi : on exige alors une nouvelle vérification.
            if (e.code === 'gmail') confirmations.set(digest, confirmation);
            throw e;
          }
          // Toute validation de cette composition devient caduque, y compris les anciennes versions.
          // SQLite peut réutiliser son identifiant après suppression du brouillon local.
          for (const [key, c] of confirmations) if (c.messageId === messageId && c.accountId === accountId) confirmations.delete(key);
          if (['reply','replyAll'].includes(parsed.mode)) store.rememberReply(messageId,parsed.text);
          store.clearDraft(messageId);
          // Le brouillon Gmail lié n'est jamais supprimé : Gmail n'offre pas de suppression conditionnelle à une version,
          // et il a pu être modifié ailleurs. Seul le brouillon local est nettoyé ; le distant est signalé.
          return !ctx.draftExternalId;
        }).then(draftRemoved => { result = { sent: true, draftRemoved }; });
      } finally {
        sending.delete(messageId);
      }
      sync.syncNow(accountId);
      return result;
    },
  };
}
