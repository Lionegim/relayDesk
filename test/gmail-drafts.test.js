import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connected, thread } from './helpers/fake-google.js';
import { createGmailOutbox } from '../src/providers/gmail/outbox.js';
import { GMAIL_SCOPES } from '../src/providers/gmail/oauth.js';
import { decodeWords } from '../src/providers/gmail/parse.js';

const READ_DRAFTS = [GMAIL_SCOPES.read, GMAIL_SCOPES.drafts];
const decode = raw => Buffer.from(raw, 'base64url').toString('utf8');
const header = (mime, name) => decodeWords(mime.split('\r\n\r\n')[0].replace(/\r\n /g, ' ').split('\r\n').find(l => l.startsWith(name + ': '))?.slice(name.length + 2));
const body = mime => Buffer.from(mime.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');

async function ready(scopes = READ_DRAFTS, threads) {
  const ctx = setup(threads ? { threads } : undefined);
  const account = await connected(ctx, scopes);
  const outbox = createGmailOutbox({ store: ctx.store, sync: ctx.sync, ownerName: 'Jean-Hugues' });
  const msg = ctx.store.snapshot().messages.find(m => m.accountId === account.id);
  ctx.g.calls.length = 0;
  return { ...ctx, account, outbox, msg };
}

test('brouillon de réponse créé dans Gmail, dans le fil, puis mis à jour', async () => {
  const { outbox, msg, g, store } = await ready();
  const d = await outbox.saveDraft(msg.id, { text: 'Mardi 10h, c’est noté. À bientôt', mode: 'reply' });
  assert.equal(d.gmail, true);
  const create = g.calls.find(c => c.method === 'POST' && c.path.endsWith('/drafts'));
  assert.equal(create.body.message.threadId, 't1');
  const mime = decode(create.body.message.raw);
  assert.equal(header(mime, 'From'), 'Jean-Hugues <jh@gmail.com>');
  assert.equal(header(mime, 'To'), 'Claire Dubois <claire@atlas.fr>');
  assert.equal(header(mime, 'Subject'), 'Re: Atelier');
  assert.equal(header(mime, 'In-Reply-To'), '<t1@atlas.fr>');
  assert.equal(body(mime), 'Mardi 10h, c’est noté. À bientôt');

  await outbox.saveDraft(msg.id, { text: 'Version 2', mode: 'reply' });
  const update = g.calls.find(c => c.method === 'PUT');
  assert.match(update.path, /\/drafts\/d1$/);
  assert.equal(body(decode(update.body.message.raw)), 'Version 2');
  const full = store.getMessage(msg.id);
  assert.deepEqual([full.draft.text, full.draft.mode, full.draft.gmail], ['Version 2', 'reply', true]);
});

test('brouillon supprimé dans Gmail : recréé', async () => {
  const { outbox, msg, g } = await ready();
  await outbox.saveDraft(msg.id, { text: 'a', mode: 'reply' });
  delete g.drafts.d1;
  await outbox.saveDraft(msg.id, { text: 'b', mode: 'reply' });
  assert.ok(g.drafts.d2, 'nouveau brouillon');
});

test('répondre à tous et transférer', async () => {
  const threads = { t1: thread('t1', { to: 'jh@gmail.com, Hugo <hugo@atlas.fr>', cc: 'team@atlas.fr', references: '<t0@atlas.fr>' }) };
  const { outbox, msg, g, store } = await ready(READ_DRAFTS, threads);
  await outbox.saveDraft(msg.id, { text: 'Pour tous', mode: 'replyAll' });
  let mime = decode(g.calls.at(-1).body.message.raw);
  assert.equal(header(mime, 'To'), 'Claire Dubois <claire@atlas.fr>, Hugo <hugo@atlas.fr>');
  assert.equal(header(mime, 'Cc'), 'team@atlas.fr');
  assert.equal(header(mime, 'References'), '<t0@atlas.fr> <t1@atlas.fr>');

  // Transfert sans destinataire : local seulement.
  g.calls.length = 0;
  const local = await outbox.saveDraft(msg.id, { text: 'Pour info', mode: 'forward', to: '' });
  assert.equal(g.calls.length, 0);
  assert.equal(local.mode, 'forward');
  await outbox.saveDraft(msg.id, { text: 'Pour info', mode: 'forward', to: 'Paul <paul@x.fr>' });
  const fwd = g.calls.at(-1).body.message;
  mime = decode(fwd.raw);
  assert.equal(fwd.threadId, undefined, 'un transfert ouvre un nouveau fil');
  assert.equal(header(mime, 'To'), 'Paul <paul@x.fr>');
  assert.equal(header(mime, 'Subject'), 'Fwd: Atelier');
  assert.match(body(mime), /^Pour info\r\n\r\n---------- Message transféré ----------\r\nDe : "Claire Dubois" <claire@atlas\.fr>/);
  assert.equal(store.getMessage(msg.id).draft.to, 'Paul <paul@x.fr>');
});

test('sans la permission brouillons : enregistrement local, aucun appel Gmail', async () => {
  const { outbox, msg, g, store } = await ready([GMAIL_SCOPES.read]);
  const d = await outbox.saveDraft(msg.id, { text: 'local', mode: 'reply' });
  assert.equal(d.gmail, false);
  assert.equal(g.calls.length, 0);
  assert.equal(store.getMessage(msg.id).draft.text, 'local');
});

test('entrées invalides et fil sans en-têtes', async () => {
  const { outbox, msg, db } = await ready();
  await assert.rejects(outbox.saveDraft(msg.id, { text: 'x', mode: 'bcc' }), e => e.status === 400);
  await assert.rejects(outbox.saveDraft(msg.id, { text: 42 }), e => e.status === 400);
  await assert.rejects(outbox.saveDraft(msg.id, { text: 'x', mode: 'forward', to: 'a@b.fr\r\nBcc: x@y.fr' }), e => e.status === 400);
  // Fil importé avant le lot C : en-têtes récupérés dans Gmail.
  db.prepare('UPDATE messages SET reply_meta = NULL WHERE id = ?').run(msg.id);
  assert.equal((await outbox.saveDraft(msg.id, { text: 'x', mode: 'reply' })).gmail, true);
  assert.ok(db.prepare('SELECT reply_meta FROM messages WHERE id = ?').get(msg.id).reply_meta);
  // Fil disparu de Gmail : 409.
  db.prepare('UPDATE messages SET reply_meta = NULL, external_id = ? WHERE id = ?').run('t404', msg.id);
  await assert.rejects(outbox.saveDraft(msg.id, { text: 'x', mode: 'reply' }), e => e.status === 409);
});

test('erreur Gmail : rien d’enregistré comme brouillon Gmail', async () => {
  const { outbox, msg, g, store } = await ready();
  g.fail = (method, path) => method === 'POST' && path === 'drafts';
  await assert.rejects(outbox.saveDraft(msg.id, { text: 'x', mode: 'reply' }), e => e.code === 'retryable');
  assert.equal(store.getMessage(msg.id).draft, null);
});
