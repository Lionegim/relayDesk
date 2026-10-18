// Brouillons et envoi Outlook (Mail.ReadWrite, Mail.Send), même contrat que Gmail : réponses dans un fil et nouveaux
// messages (kind 'new'). Le MIME est construit côté serveur avec le module commun ; l'envoi passe toujours par
// /me/sendMail avec le MIME validé, jamais par l'envoi d'un brouillon (modifiable ailleurs).
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest } from '../../http/errors.js';
import { buildMessage, envelope, forwardBody, formatAddress, parseAddressList, MimeError } from '../gmail/mime.js';
import { readComposeInput } from '../../mail/input.js';
import { replyMeta } from './parse.js';

const CONFIRM_TTL_MS = 10 * 60000;
const digestOf = (mime, threadId) => createHash('sha256').update(`thread:${threadId || ''}\n`).update(mime, 'utf8').digest('hex');

// Clé du rattachement au fil d'un brouillon Outlook : un PATCH ne modifie ni In-Reply-To, ni References, ni
// l'association à la conversation. Si cette clé change (répondre → transférer, nouveau message dans le fil),
// le brouillon est recréé à partir du MIME exact.
const threadKeyOf = (mode, env, threadId) => createHash('sha256').update(JSON.stringify({
  kind: mode === 'new' ? 'new' : mode === 'forward' ? 'forward' : 'reply',
  threadId: threadId || null, inReplyTo: env.inReplyTo || null, references: env.references || null,
})).digest('hex');

const mimeErrors = fn => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MimeError) throw badRequest(e.message);
    throw e;
  }
};

// Destinataires saisis, sans doublon ni sa propre adresse en copie.
function newEnvelope({ to, cc, subject }, own) {
  const seen = new Set();
  const uniq = list => list.filter(a => !seen.has(a.email) && seen.add(a.email));
  const toList = uniq(parseAddressList(to));
  if (!toList.length) throw new MimeError('Indique au moins un destinataire valide.');
  const ccList = uniq(parseAddressList(cc).filter(a => a.email !== own.email));
  return { to: toList, cc: ccList, subject };
}

const recipients = list => list.map(a => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } }));

export function createOutlookOutbox({ store, sync, ownerName = '' }) {
  const sending = new Set();
  const confirmations = new Map(); // empreinte -> { messageId, accountId, generation, expires }
  const sweep = () => { const now = Date.now(); for (const [d, c] of confirmations) if (c.expires < now) confirmations.delete(d); };
  const isOutlook = accountId => accountId != null && store.hasAccount(accountId) && store.getAccount(accountId).svc === 'outlook';
  const can = (accountId, perm) => isOutlook(accountId) && sync.permissions(accountId).includes(perm);

  // Contrôle d'entrée commun : un nouveau message ne s'écrit qu'en mode 'new', une réponse jamais.
  function input(messageId, raw) {
    const parsed = readComposeInput(raw);
    const ctx = store.composeContext(messageId);
    if ((ctx.kind === 'new') !== (parsed.mode === 'new')) throw badRequest(ctx.kind === 'new' ? 'Ce brouillon est un nouveau message' : 'Mode de réponse invalide pour ce fil');
    return { ...parsed, ctx };
  }

  // Message exact (MIME) ; pour un nouveau message, aucun appel distant.
  function compose(messageId, { text, mode, to, cc, subject }) {
    const ctx = store.composeContext(messageId);
    const account = store.getAccount(ctx.accountId);
    if (!account.address) throw new HttpError(409, 'Adresse du compte inconnue : reconnecte le compte.', 'compose_unavailable');
    const own = { name: ownerName, email: account.address };
    return mimeErrors(() => {
      if (ctx.kind === 'new') {
        const env = newEnvelope({ to, cc, subject }, own);
        return { ctx, own, env, body: text, mime: buildMessage({ from: own, ...env, body: text }), threadId: undefined };
      }
      if (!ctx.reply) throw new HttpError(409, 'Les en-têtes de ce fil ne sont pas encore importés : synchronise le compte puis réessaie.', 'compose_unavailable');
      const original = { ...ctx.reply, subject: ctx.subject, body: ctx.body, date: ctx.reply.at ? new Date(ctx.reply.at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '' };
      const env = envelope({ mode, own, original, forwardTo: to || '' });
      const body = mode === 'forward' ? forwardBody(text, original) : text;
      return { ctx, own, env, body, mime: buildMessage({ from: own, ...env, body }), threadId: mode === 'forward' ? undefined : ctx.threadId };
    });
  }

  // Fils importés sans en-têtes de réponse : relus dans Outlook. Jamais pour un nouveau message.
  async function ensureReply(graph, messageId) {
    const ctx = store.composeContext(messageId);
    if (ctx.kind === 'new' || ctx.reply || !ctx.threadId) return;
    const reply = replyMeta(await graph.conversation(ctx.threadId));
    if (!reply) throw new HttpError(409, 'Ce fil n’existe plus dans Outlook.', 'compose_unavailable');
    store.setReplyMeta(messageId, reply);
  }

  const hasRecipient = ({ mode, to }) => (mode !== 'forward' && mode !== 'new') || String(to || '').includes('@');

  return {
    can,

    // Brouillon Outlook (Mail.ReadWrite) : créé à partir du MIME exact, puis mis à jour (objet, corps, destinataires).
    async saveDraft(messageId, raw) {
      const { text, mode, to, cc, subject, ctx } = input(messageId, raw);
      const local = () => store.saveDraft(messageId, text, { mode, to, cc, subject });
      if (!isOutlook(ctx.accountId)) return local();
      if (!can(ctx.accountId, 'drafts') || !hasRecipient({ mode, to })) return sync.queue(ctx.accountId, local);
      return sync.exclusive(ctx.accountId, async ({ graph }) => {
        await ensureReply(graph, messageId);
        const { mime, env, body, threadId, ctx: fresh } = compose(messageId, { text, mode, to, cc, subject });
        const threadKey = threadKeyOf(mode, env, threadId);
        let draftId = fresh.draftExternalId, previousDraftKept = false;
        // Clé inconnue (brouillon antérieur ou colonne draft_thread_key absente) : on ne peut pas prouver que les
        // en-têtes de fil du brouillon distant sont à jour, donc on recrée. L'ancien brouillon distant est conservé
        // (il a pu être modifié ailleurs ; Graph n'offre pas de suppression conditionnelle).
        if (draftId && fresh.draftThreadKey !== threadKey) {
          draftId = null;
          previousDraftKept = true;
        }
        if (draftId) {
          try {
            await graph.patchDraft(draftId, {
              subject: env.subject, body: { contentType: 'text', content: body },
              toRecipients: recipients(env.to), ccRecipients: recipients(env.cc),
            });
          } catch (e) {
            if (e.code !== 'not_found') throw e;
            draftId = null; // supprimé dans Outlook entre-temps : on en recrée un
          }
        }
        if (!draftId) draftId = (await graph.createDraftMime(mime)).id;
        const saved = store.saveDraft(messageId, text, { mode, to, cc, subject, externalId: draftId, synced: true, threadKey });
        return previousDraftKept ? { ...saved, previousDraftKept } : saved;
      });
    },

    async preview(messageId, raw) {
      const { text, mode, to, cc, subject, ctx } = input(messageId, raw);
      if (!can(ctx.accountId, 'send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
      if (!text.trim()) throw badRequest('Le message est vide.');
      return sync.exclusive(ctx.accountId, async ({ graph }) => {
        await ensureReply(graph, messageId);
        const { own, env, body, mime, threadId } = compose(messageId, { text, mode, to, cc, subject });
        const digest = digestOf(mime, threadId);
        sweep();
        confirmations.set(digest, { messageId, accountId: ctx.accountId, generation: sync.generation(ctx.accountId), expires: Date.now() + CONFIRM_TTL_MS });
        return { from: formatAddress(own), to: env.to.map(formatAddress), cc: env.cc.map(formatAddress), subject: env.subject, body, digest };
      });
    },

    async send(messageId, raw) {
      const { text, mode, to, cc, subject, ctx } = input(messageId, raw);
      const digest = raw?.digest;
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw badRequest('Empreinte de validation manquante.');
      const accountId = ctx.accountId;
      if (!can(accountId, 'send')) throw new HttpError(403, 'La permission Envoi n’est pas accordée pour ce compte.', 'send_forbidden');
      if (sending.has(messageId)) throw new HttpError(409, 'Un envoi est déjà en cours pour ce message.', 'send_in_progress');
      sending.add(messageId);
      let result;
      try {
        result = await sync.exclusive(accountId, async ({ graph }) => {
          await ensureReply(graph, messageId);
          const { mime, threadId, ctx: fresh } = compose(messageId, { text, mode, to, cc, subject });
          if (!timingSafeEqual(Buffer.from(digestOf(mime, threadId)), Buffer.from(digest))) {
            throw new HttpError(409, 'Le message a changé depuis sa validation : vérifie-le à nouveau avant d’envoyer.', 'digest_mismatch');
          }
          sweep();
          const confirmation = confirmations.get(digest);
          if (!confirmation || confirmation.messageId !== messageId || confirmation.accountId !== accountId
            || confirmation.generation !== sync.generation(accountId)) {
            throw new HttpError(409, 'Validation absente, expirée ou déjà utilisée : vérifie le message à nouveau.', 'confirmation_invalid');
          }
          confirmations.delete(digest);
          try {
            await graph.sendMime(mime);
          } catch (e) {
            // Refus net (4xx) : rien n'est parti, la validation reste utilisable. Erreur réseau ou 5xx : envoi incertain.
            if (e.code === 'provider') confirmations.set(digest, confirmation);
            throw e;
          }
          // Toutes les validations de ce message sont annulées avant de libérer la ligne : un identifiant de nouveau
          // message réutilisé par SQLite ne peut jamais hériter d'un aperçu antérieur.
          for (const [d, c] of confirmations) if (c.messageId === messageId && c.accountId === accountId) confirmations.delete(d);
          store.clearDraft(messageId);
          // Le brouillon Outlook lié n'est jamais supprimé (pas de suppression conditionnelle à une version).
          return { sent: true, draftRemoved: !fresh.draftExternalId };
        });
      } finally {
        sending.delete(messageId);
      }
      sync.syncNow(accountId);
      return result;
    },
  };
}
