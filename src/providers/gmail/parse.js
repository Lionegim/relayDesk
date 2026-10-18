// Conversion d'une conversation Gmail (format=full) en ligne de messages Relay. Les corps restent en texte brut :
// le HTML est réduit en texte, jamais rendu.
import { triageEmail } from '../../triage.js';

const MAX_BODY = 20000;
const SKIP = ['TRASH', 'SPAM', 'DRAFT'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', rsquo: '’', lsquo: '‘', hellip: '…', mdash: '—', ndash: '–', euro: '€' };
export const decodeEntities = s => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

// En-têtes encodés RFC 2047 (=?utf-8?B?...?= / =?utf-8?Q?...?=).
export function decodeWords(s) {
  return String(s ?? '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return m;
    }
  });
}

export function parseAddress(raw) {
  const s = decodeWords(raw).trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: s, email: s.toLowerCase() };
}

export const initialsOf = name => name.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

const headerMap = msg => Object.fromEntries((msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));

function decodeData(data, contentType = '') {
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] || 'utf-8';
  const bytes = Buffer.from(data, 'base64url');
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Retire la citation du message précédent (« Le … a écrit : », « On … wrote: », lignes « > »).
export function stripQuoted(text) {
  const lines = text.split('\n');
  const cut = lines.findIndex(l => /^(Le .+ a écrit\s*:|On .+ wrote:|-{2,}\s*Original Message|-{2,}\s*Message d’origine)/i.test(l.trim()));
  return (cut > 0 ? lines.slice(0, cut) : lines).filter(l => !l.startsWith('>')).join('\n').trim();
}

function findPart(payload, mime) {
  if (!payload) return null;
  const disposition = (payload.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
  if (payload.mimeType === mime && payload.body?.data && !/attachment/i.test(disposition)) return payload;
  for (const p of payload.parts || []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

export function bodyText(msg) {
  const ct = p => (p.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value;
  const plain = findPart(msg.payload, 'text/plain');
  let text = plain ? decodeData(plain.body.data, ct(plain)) : '';
  if (!text.trim()) {
    const html = findPart(msg.payload, 'text/html');
    text = html ? htmlToText(decodeData(html.body.data, ct(html))) : decodeEntities(msg.snippet);
  }
  text = stripQuoted(text.replace(/\r\n/g, '\n')) || text.trim();
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '\n…' : text;
}

// En-têtes bruts (non décodés) du dernier message visible, pour répondre dans le fil.
export function replyMeta(thread) {
  const last = (thread.messages || []).filter(m => !(m.labelIds || []).some(l => SKIP.includes(l))).at(-1);
  if (!last) return null;
  const h = headerMap(last);
  return { from: h.from || '', to: h.to || '', cc: h.cc || '', replyTo: h['reply-to'] || '', messageId: h['message-id'] || '', references: h.references || '', at: Number(last.internalDate) || null };
}

// Renvoie null si la conversation ne contient plus de message visible (corbeille, spam, brouillon seul).
export function threadToRecord(thread, { ownEmail, labelNames = {}, preferredLabelId = null }) {
  const msgs = (thread.messages || []).filter(m => !(m.labelIds || []).some(l => SKIP.includes(l)));
  if (!msgs.length) return null;
  const labels = new Set(msgs.flatMap(m => m.labelIds || []));
  const last = msgs.at(-1);
  const h = headerMap(last);
  const who = m => {
    const a = parseAddress(headerMap(m).from || '');
    return a.email === ownEmail ? { name: 'Moi', email: a.email } : a;
  };
  const from = who(last);
  const userLabel = preferredLabelId && labels.has(preferredLabelId) && labelNames[preferredLabelId]
    ? preferredLabelId : [...labels].find(l => labelNames[l]);
  return {
    externalId: thread.id,
    ownSamples: msgs.filter(m => (m.labelIds || []).includes('SENT') && parseAddress(headerMap(m).from || '').email === ownEmail?.toLowerCase()).map(m=>({fromMe:true,text:bodyText(m),at:Number(m.internalDate)})),
    from: from.name, initials: initialsOf(from.name), handle: from.email,
    sortAt: Number(last.internalDate) || Date.now(),
    unread: labels.has('UNREAD'), flagged: labels.has('STARRED'), archived: !labels.has('INBOX'),
    subject: decodeWords(headerMap(msgs[0]).subject || h.subject || '').trim() || '(Sans objet)',
    preview: decodeEntities(last.snippet),
    body: bodyText(last),
    trail: msgs.slice(0, -1).reverse().map(m => {
      const a = who(m);
      return { from: a.name, initials: initialsOf(a.name), at: Number(m.internalDate), body: bodyText(m) };
    }),
    count: msgs.length,
    labelId: userLabel || null,
    reply: replyMeta(thread),
    ...triageEmail({ labels, headers: h }),
  };
}
