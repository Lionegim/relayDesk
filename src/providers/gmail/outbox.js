// Lot C : brouillons Gmail. Les messages sont construits côté serveur à partir des en-têtes stockés du fil ;
// le navigateur n'envoie que le texte, le mode et, pour un transfert, les destinataires.
import { HttpError, badRequest } from '../../http/errors.js';
import { buildMessage, envelope, forwardBody, toRaw, MimeError } from './mime.js';
import { replyMeta } from './parse.js';

const MODES = ['reply', 'replyAll', 'forward'];
const MAX_TEXT = 20000;
const MAX_TO = 2000;
export function readComposeInput(body) {
  const { text, mode = 'reply', to = null } = body || {};
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw badRequest('Texte invalide');
  if (!MODES.includes(mode)) throw badRequest('Mode de réponse invalide');
  if (to !== null && (typeof to !== 'string' || to.length > MAX_TO || /[\r\n\0]/.test(to))) throw badRequest('Destinataires invalides');
  return { text, mode, to: mode === 'forward' ? (to || '') : null };
}

const mimeErrors = fn => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MimeError) throw badRequest(e.message);
    throw e;
  }
};

export function createGmailOutbox({ store, sync, ownerName = '' }) {
  const isGmail = accountId => accountId != null && store.hasAccount(accountId) && store.getAccount(accountId).svc === 'gmail';
  const can = (accountId, perm) => isGmail(accountId) && sync.permissions(accountId).includes(perm);

  // Message exact (MIME) pour ce fil, ce mode et ce texte.
  function compose(messageId, { text, mode, to }) {
    const ctx = store.composeContext(messageId);
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
    if (ctx.reply || !ctx.threadId) return;
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
      const { text, mode, to } = readComposeInput(input);
      const { accountId } = store.composeContext(messageId);
      const local = () => store.saveDraft(messageId, text, { mode, to });
      if (!isGmail(accountId)) return local();
      // Toutes les sauvegardes d'un compte Gmail passent par sa file, y compris l'enregistrement local :
      // une écriture Gmail plus ancienne encore en cours ne peut pas écraser un brouillon plus récent.
      // Un transfert sans destinataire valide reste local jusqu'à ce qu'une adresse soit saisie.
      if (!can(accountId, 'drafts') || (mode === 'forward' && !String(to).includes('@'))) return sync.queue(accountId, local);
      return sync.exclusive(accountId, async ({ gmail }) => {
        await ensureReply(gmail, messageId);
        const { mime, threadId, ctx } = compose(messageId, { text, mode, to });
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
        return store.saveDraft(messageId, text, { mode, to, externalId: draftId, synced: true });
      });
    },
  };
}
