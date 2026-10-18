import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, toRaw, envelope, forwardBody, parseAddressList, formatAddress, encodeHeaderText, MimeError } from '../src/providers/gmail/mime.js';
import { decodeWords } from '../src/providers/gmail/parse.js';

const own = { name: 'Jean-Hugues', email: 'jh@gmail.com' };
const original = {
  from: '"Claire Dubois" <claire@atlas.fr>', to: 'jh@gmail.com, Hugo <hugo@atlas.fr>', cc: 'Équipe <team@atlas.fr>, JH <JH@gmail.com>',
  replyTo: '', subject: 'Atelier de cadrage', messageId: '<m2@atlas.fr>', references: '<m1@atlas.fr>', body: 'Mardi 10h ?', date: '3 oct. 2026',
};

const headersOf = mime => {
  const head = mime.split('\r\n\r\n')[0].replace(/\r\n /g, ' ');
  return Object.fromEntries(head.split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
};
const bodyOf = mime => Buffer.from(mime.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');

test('message UTF-8 : CRLF, en-têtes encodés, corps base64', () => {
  const mime = buildMessage({ from: own, to: [{ name: 'Claire Dubois', email: 'claire@atlas.fr' }], subject: 'Réunion à 10h', body: 'Ça marche.\nÀ mardi.' });
  assert.ok(!/(^|[^\r])\n/.test(mime), 'uniquement des fins de ligne CRLF');
  assert.ok(mime.split('\r\n').every(l => l.length <= 998));
  const h = headersOf(mime);
  assert.equal(h.From, 'Jean-Hugues <jh@gmail.com>');
  assert.equal(h.To, 'Claire Dubois <claire@atlas.fr>');
  assert.match(h.Subject, /^=\?UTF-8\?B\?/);
  assert.equal(decodeWords(h.Subject), 'Réunion à 10h');
  assert.equal(h['Content-Type'], 'text/plain; charset=UTF-8');
  assert.equal(bodyOf(mime), 'Ça marche.\r\nÀ mardi.');
  assert.ok(!('Date' in h) && !('Message-ID' in h), 'déterministe');
  assert.equal(buildMessage({ from: own, to: [own], subject: 'x', body: 'y' }), buildMessage({ from: own, to: [own], subject: 'x', body: 'y' }));
  assert.equal(Buffer.from(toRaw(mime), 'base64url').toString('utf8'), mime);
});

test('noms : guillemets, caractères spéciaux, non-ASCII', () => {
  assert.equal(formatAddress({ name: 'Dubois, Claire', email: 'c@a.fr' }), '"Dubois, Claire" <c@a.fr>');
  assert.equal(formatAddress({ name: 'Le "chef"', email: 'c@a.fr' }), '"Le \\"chef\\"" <c@a.fr>');
  assert.equal(decodeWords(formatAddress({ name: 'Hélène', email: 'h@a.fr' }).split(' <')[0]), 'Hélène');
  const long = encodeHeaderText('é'.repeat(80));
  assert.ok(long.split(' ').every(w => w.length <= 75));
  assert.equal(decodeWords(long), 'é'.repeat(80));
});

test('injection d’en-têtes refusée', () => {
  assert.throws(() => buildMessage({ from: own, to: [own], subject: 'Salut\r\nBcc: victime@x.fr', body: '' }), MimeError);
  assert.throws(() => formatAddress({ name: 'A\nBcc: x@y.fr', email: 'a@b.fr' }), MimeError);
  assert.throws(() => formatAddress({ email: 'a@b.fr\r\nBcc: x@y.fr' }), MimeError);
  assert.throws(() => buildMessage({ from: own, to: [own], inReplyTo: '<a>\nX: y', body: '' }), MimeError);
  assert.throws(() => formatAddress({ email: 'pas-une-adresse' }), MimeError);
  // Une ligne « Bcc: » dans le corps reste du contenu encodé, pas un en-tête.
  const mime = buildMessage({ from: own, to: [own], subject: 's', body: '\r\nBcc: x@y.fr' });
  assert.ok(!('Bcc' in headersOf(mime)));
});

test('liste d’adresses : virgules entre guillemets, encodage, entrées invalides', () => {
  assert.deepEqual(parseAddressList('"Dubois, Claire" <Claire@Atlas.fr>, hugo@atlas.fr, n\'importe quoi, =?UTF-8?B?w4lxdWlwZQ==?= <t@a.fr>'), [
    { name: 'Dubois, Claire', email: 'claire@atlas.fr' }, { name: '', email: 'hugo@atlas.fr' }, { name: 'Équipe', email: 't@a.fr' },
  ]);
});

test('répondre : destinataire, objet, fil', () => {
  const e = envelope({ mode: 'reply', own, original });
  assert.deepEqual(e.to.map(a => a.email), ['claire@atlas.fr']);
  assert.deepEqual(e.cc, []);
  assert.equal(e.subject, 'Re: Atelier de cadrage');
  assert.equal(e.inReplyTo, '<m2@atlas.fr>');
  assert.equal(e.references, '<m1@atlas.fr> <m2@atlas.fr>');
  assert.equal(envelope({ mode: 'reply', own, original: { ...original, subject: 'RE: Atelier' } }).subject, 'RE: Atelier');
  assert.deepEqual(envelope({ mode: 'reply', own, original: { ...original, replyTo: 'support@atlas.fr' } }).to.map(a => a.email), ['support@atlas.fr']);
});

test('répondre à tous : sans moi ni doublons', () => {
  const e = envelope({ mode: 'replyAll', own, original });
  assert.deepEqual(e.to.map(a => a.email), ['claire@atlas.fr', 'hugo@atlas.fr']);
  assert.deepEqual(e.cc.map(a => a.email), ['team@atlas.fr']);
  // Dernier message envoyé par moi : on relance ses destinataires.
  const mine = envelope({ mode: 'reply', own, original: { ...original, from: 'JH <jh@gmail.com>' } });
  assert.deepEqual(mine.to.map(a => a.email), ['hugo@atlas.fr']);
});

test('transférer : adresse saisie, objet, message cité', () => {
  const e = envelope({ mode: 'forward', own, original, forwardTo: 'Paul <paul@x.fr>, paul@x.fr' });
  assert.deepEqual(e.to.map(a => a.email), ['paul@x.fr']);
  assert.equal(e.subject, 'Fwd: Atelier de cadrage');
  assert.equal(e.inReplyTo, undefined);
  assert.throws(() => envelope({ mode: 'forward', own, original, forwardTo: 'personne' }), MimeError);
  const body = forwardBody('Pour info.', original);
  assert.match(body, /^Pour info\.\n\n---------- Message transféré ----------\nDe : "Claire Dubois" <claire@atlas.fr>\nDate : 3 oct\. 2026\nObjet : Atelier de cadrage/);
  assert.match(body, /Mardi 10h \?$/);
  assert.throws(() => envelope({ mode: 'nope', own, original }), MimeError);
});

test('en-tête References long replié', () => {
  const refs = Array.from({ length: 12 }, (_, i) => `<message-${i}@exemple.fr>`).join(' ');
  const mime = buildMessage({ from: own, to: [own], subject: 's', references: refs, body: '' });
  const lines = mime.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(lines.every(l => l.length <= 78));
  assert.equal(headersOf(mime).References, refs);
});
