// Construction commune de messages RFC 5322 en UTF-8 (Gmail et Microsoft Graph).
// Le résultat est déterministe (ni Date ni Message-ID : Gmail les ajoute), ce qui permet
// de hacher exactement ce qui a été validé avant l'envoi.
import { decodeWords } from '../providers/gmail/parse.js';

const CRLF = '\r\n';
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const MAX_LINE = 76;

export class MimeError extends Error {}

const noBreaks = (value, what) => {
  if (/[\r\n\0]/.test(value)) throw new MimeError(`${what} contient un retour à la ligne interdit.`);
  return value;
};

const isAscii = s => /^[\x20-\x7e]*$/.test(s);

// Mots encodés RFC 2047 en base64, découpés sans couper un caractère UTF-8 (≤ 75 caractères par mot).
function encodedWords(s) {
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

// Texte d'en-tête : encodé en mots RFC 2047 s'il n'est pas ASCII ou s'il contient un mot trop long pour être replié.
const needsEncoding = s => !isAscii(s) || s.split(' ').some(w => w.length > 60);

export function encodeHeaderText(value, what = 'En-tête') {
  noBreaks(String(value), what);
  return needsEncoding(value) ? encodedWords(value) : value;
}

export function formatAddress({ name = '', email }) {
  noBreaks(String(email), 'Adresse');
  noBreaks(String(name), 'Nom');
  if (email.length > 254 || !EMAIL.test(email)) throw new MimeError(`Adresse invalide : ${email}`);
  if (!name || name === email) return email;
  const display = needsEncoding(name)
    ? encodedWords(name)
    : (/[()<>@,;:\\".[\]]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name);
  return `${display} <${email}>`;
}

// Découpe au premier niveau : virgules hors guillemets, commentaires et chevrons, en respectant les échappements.
// L'analyse porte sur l'en-tête brut : les mots RFC 2047 ne sont décodés que dans les noms, après coup,
// pour qu'un nom encodé ne puisse jamais introduire d'adresse.
// Avec `groups`, les virgules entre « nom: » et « ; » d'un groupe ne séparent pas (le groupe reste entier).
function splitTopLevel(s, sep, { groups = false } = {}) {
  const parts = [];
  let cur = '', quoted = false, depth = 0, angle = false, group = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((quoted || depth) && ch === '\\' && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (quoted) { if (ch === '"') quoted = false; }
    else if (depth) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    else if (ch === '"') quoted = true;
    else if (ch === '(') depth++;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    else if (groups && ch === ':' && !angle) group = true;
    else if (groups && ch === ';' && !angle) group = false;
    else if (sep.includes(ch) && !angle && !group) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Retire les commentaires (imbriqués) et renvoie le texte restant et le premier commentaire.
function stripComments(s) {
  let out = '', depth = 0, quoted = false, comment = '', first = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((quoted || depth) && ch === '\\' && i + 1 < s.length) {
      if (depth) comment += s[i + 1]; else out += ch + s[i + 1];
      i++; continue;
    }
    if (depth) {
      if (ch === '(') { depth++; comment += ch; }
      else if (ch === ')') { if (--depth === 0) { if (first === null) first = comment.trim(); comment = ''; } else comment += ch; }
      else comment += ch;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === '(' && !quoted) { depth = 1; continue; }
    out += ch;
  }
  return { text: out, comment: first };
}

const unquote = s => {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t;
};

function parseMailbox(raw) {
  const { text, comment } = stripComments(raw);
  const lt = text.lastIndexOf('<');
  let email, name;
  if (lt >= 0) {
    const gt = text.indexOf('>', lt);
    if (gt < 0 || text.slice(gt + 1).trim()) return null;
    email = text.slice(lt + 1, gt);
    name = unquote(text.slice(0, lt));
    // Mots encodés seulement hors guillemets (RFC 2047 §5) ; le résultat reste un simple nom.
    if (!/^\s*"/.test(text.slice(0, lt))) name = decodeWords(name);
  } else {
    email = text;
    name = comment ? decodeWords(comment) : '';
  }
  email = email.replace(/\s+/g, '').toLowerCase();
  if (email.startsWith('@') || email.includes(':')) email = email.slice(email.lastIndexOf(':') + 1); // route source obsolète
  return EMAIL.test(email) && email.length <= 254 ? { name: name.replace(/\s+/g, ' ').trim(), email } : null;
}

// Liste d'adresses d'un en-tête (mailboxes et groupes). Les entrées sans adresse valide sont ignorées.
export function parseAddressList(raw, { strict = false } = {}) {
  const mailbox = value => { const m = parseMailbox(value); if (strict && !m && value.trim()) throw new MimeError('Adresse de destinataire invalide.'); return m; };
  const out = [];
  for (const part of splitTopLevel(String(raw || ''), ',', { groups: true })) {
    // Groupe « nom: a, b; » : ses membres sont découpés avec la même analyse structurelle.
    const group = splitTopLevel(part, ':');
    if (group.length > 1 && !part.trim().startsWith('<')) {
      const inner = group.slice(1).join(':').replace(/;\s*$/, '');
      out.push(...splitTopLevel(inner, ',').map(mailbox).filter(Boolean));
      continue;
    }
    const m = mailbox(part.replace(/;\s*$/, ''));
    if (m) out.push(m);
  }
  return out;
}

// Repli des en-têtes longs sur les espaces (RFC 5322 §2.2.3). Un élément indivisible au-delà de 998 octets est refusé.
function fold(line) {
  const out = [];
  let cur = '';
  for (const word of line.split(' ')) {
    if (cur && (cur + ' ' + word).length > MAX_LINE) { out.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word;
  }
  out.push(cur);
  if (out.some(l => Buffer.byteLength(l) > 997)) throw new MimeError(`En-tête ${line.slice(0, line.indexOf(':'))} trop long.`);
  return out.join(CRLF + ' ');
}

const base64Lines = text => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join(CRLF) ?? '';

export function buildMessage({ from, to = [], cc = [], subject = '', inReplyTo, references, body = '' }) {
  if (!to.length) throw new MimeError('Au moins un destinataire est requis.');
  const headers = [
    ['From', formatAddress(from)],
    ['To', to.map(formatAddress).join(', ')],
    cc.length && ['Cc', cc.map(formatAddress).join(', ')],
    ['Subject', encodeHeaderText(subject, 'Objet')],
    inReplyTo && ['In-Reply-To', noBreaks(inReplyTo, 'In-Reply-To')],
    references && ['References', noBreaks(references, 'References')],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64'],
  ].filter(Boolean);
  const normalized = String(body).replace(/\r\n?/g, '\n').replace(/\n/g, CRLF);
  return headers.map(([k, v]) => fold(`${k}: ${v}`)).join(CRLF) + CRLF + CRLF + base64Lines(normalized) + CRLF;
}

export const toRaw = mime => Buffer.from(mime, 'utf8').toString('base64url');

const prefixed = (subject, prefix, pattern) => (pattern.test(subject) ? subject : `${prefix} ${subject}`).trim();

const dedupe = (list, exclude) => {
  const seen = new Set(exclude.map(e => e.toLowerCase()));
  return list.filter(a => !seen.has(a.email) && seen.add(a.email));
};

// Destinataires, objet et en-têtes de fil selon le mode. `original` décrit le dernier message du fil.
export function envelope({ mode, own, original, forwardTo = '' }) {
  const self = own.email.toLowerCase();
  const subject = original.subject || '';
  if (mode === 'forward') {
    const to = dedupe(parseAddressList(forwardTo), []);
    if (!to.length) throw new MimeError('Indique au moins une adresse valide pour le transfert.');
    return { to, cc: [], subject: prefixed(subject, 'Fwd:', /^\s*(fwd?|tr)\s*:/i) };
  }
  if (mode !== 'reply' && mode !== 'replyAll') throw new MimeError('Mode de réponse inconnu.');
  const from = parseAddressList(original.from);
  const replyTo = parseAddressList(original.replyTo);
  const origTo = parseAddressList(original.to);
  const fromMe = from[0]?.email === self;
  // Si le dernier message vient de moi, répondre revient à relancer ses destinataires.
  let to = fromMe ? origTo : (replyTo.length ? replyTo : from);
  let cc = [];
  if (mode === 'replyAll') {
    to = [...to, ...(fromMe ? [] : origTo)];
    cc = parseAddressList(original.cc);
  }
  to = dedupe(to, [self]);
  cc = dedupe(cc, [self, ...to.map(a => a.email)]);
  if (!to.length) throw new MimeError('Aucun destinataire pour cette réponse.');
  const messageId = original.messageId?.trim();
  return {
    to, cc,
    subject: prefixed(subject, 'Re:', /^\s*re\s*:/i),
    inReplyTo: messageId || undefined,
    references: [original.references, messageId].filter(Boolean).join(' ').trim() || undefined,
  };
}

// Corps du transfert : le texte saisi, puis le message d'origine sous un séparateur.
export function forwardBody(text, original) {
  return [
    text.trimEnd(), '', '---------- Message transféré ----------',
    `De : ${original.from || ''}`, original.date ? `Date : ${original.date}` : null,
    `Objet : ${original.subject || ''}`, `À : ${original.to || ''}`, '', original.body || '',
  ].filter(l => l !== null).join('\n');
}
