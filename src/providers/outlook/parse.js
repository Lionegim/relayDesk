// Conversion d'une conversation Graph (messages d'un même conversationId) en ligne Relay, au même format que Gmail.
// Les corps sont demandés en texte brut à Graph ; rien n'est rendu en HTML.
import { triageEmail } from '../../triage.js';
import { initialsOf, stripQuoted } from '../gmail/parse.js';

const MAX_BODY = 20000;

// En-tête d'adresses reconstruit depuis les objets Graph : noms entre guillemets échappés, sans caractères de contrôle.
// Les adresses non SMTP (X.500 Exchange, etc.) sont ignorées.
const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const one = r => {
  const address = clean(r?.emailAddress?.address).toLowerCase();
  if (!address.includes('@')) return null;
  const name = clean(r?.emailAddress?.name);
  return name && name.toLowerCase() !== address ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>` : address;
};
export const addressHeader = list => (Array.isArray(list) ? list : [list]).map(one).filter(Boolean).join(', ');

const at = m => Date.parse(m.receivedDateTime || m.sentDateTime || '') || 0;
const header = (m, name) => (m.internetMessageHeaders || []).find(h => h.name?.toLowerCase() === name)?.value || '';

export function bodyText(m) {
  let text = String(m.body?.content ?? m.bodyPreview ?? '').replace(/\r\n/g, '\n');
  text = stripQuoted(text) || text.trim();
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '\n…' : text;
}

// En-têtes bruts (format RFC 5322) du dernier message visible, pour répondre dans le fil.
export function replyMeta(messages, { skipFolders = new Set() } = {}) {
  const last = visible(messages, skipFolders).at(-1);
  if (!last) return null;
  return {
    from: addressHeader(last.from), to: addressHeader(last.toRecipients || []), cc: addressHeader(last.ccRecipients || []),
    replyTo: addressHeader(last.replyTo || []), messageId: clean(last.internetMessageId), references: clean(header(last, 'references')),
    at: at(last) || null,
  };
}

const visible = (messages, skipFolders) => (messages || [])
  .filter(m => !m.isDraft && !skipFolders.has(m.parentFolderId))
  .sort((a, b) => at(a) - at(b));

// folders : { inbox, skip:Set (corbeille, courrier indésirable, brouillons), user: { id → nom } }.
export function conversationToRecord(conversationId, messages, { ownEmail, folders, preferredLabelId = null }) {
  const msgs = visible(messages, folders.skip);
  if (!msgs.length) return null;
  const last = msgs.at(-1);
  const who = m => {
    const address = clean(m.from?.emailAddress?.address).toLowerCase();
    if (address && address === ownEmail) return { name: 'Moi', email: address };
    const name = clean(m.from?.emailAddress?.name) || address || 'Inconnu';
    return { name, email: address };
  };
  const from = who(last);
  // Étiquettes équivalentes à Gmail pour réutiliser le triage local.
  const labels = new Set();
  if (msgs.some(m => !m.isRead)) labels.add('UNREAD');
  if (msgs.some(m => m.importance === 'high')) labels.add('IMPORTANT');
  if (last.inferenceClassification === 'other') labels.add('CATEGORY_PROMOTIONS');
  const userIds = msgs.map(m => m.parentFolderId).filter(id => folders.user[id]);
  const labelId = preferredLabelId && userIds.includes(preferredLabelId) ? preferredLabelId : (userIds.at(-1) || null);
  return {
    externalId: conversationId,
    from: from.name, initials: initialsOf(from.name), handle: from.email,
    sortAt: at(last) || Date.now(),
    unread: labels.has('UNREAD'),
    flagged: msgs.some(m => m.flag?.flagStatus === 'flagged'),
    archived: !msgs.some(m => m.parentFolderId === folders.inbox),
    subject: clean(msgs[0].subject || last.subject) || '(Sans objet)',
    preview: clean(last.bodyPreview),
    body: bodyText(last),
    trail: msgs.slice(0, -1).reverse().map(m => { const a = who(m); return { from: a.name, initials: initialsOf(a.name), at: at(m), body: bodyText(m) }; }),
    count: msgs.length,
    labelId,
    reply: replyMeta(msgs),
    ...triageEmail({ labels, headers: { 'list-unsubscribe': header(last, 'list-unsubscribe') } }),
  };
}
