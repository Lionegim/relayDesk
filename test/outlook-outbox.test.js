import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setupOutlook, connectedOutlook, G } from './outlook-helpers.js';
import { createOutlookOutbox } from '../src/providers/outlook/outbox.js';
import { createOutlookDisconnect } from '../src/providers/outlook/disconnect.js';
import { decodeWords } from '../src/providers/gmail/parse.js';

const ALL = [`${G}Mail.ReadWrite`, `${G}Mail.Send`];
const header = (mime, name) => decodeWords(mime.split('\r\n\r\n')[0].replace(/\r\n /g, ' ').split('\r\n').find(l => l.startsWith(name + ': '))?.slice(name.length + 2));
const bodyOf = mime => Buffer.from(mime.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
const sha = (mime, thread = '') => createHash('sha256').update(`thread:${thread}\n`).update(mime).digest('hex');

async function ready(scopes = ALL) {
  const ctx = setupOutlook();
  ctx.ms.add({ conversationId: 'C1', ccRecipients: [{ emailAddress: { name: 'Hugo', address: 'hugo@atlas.fr' } }], receivedDateTime: new Date(Date.now() - 3600000).toISOString() });
  const account = await connectedOutlook(ctx, scopes);
  const outbox = createOutlookOutbox({ store: ctx.store, sync: ctx.sync, ownerName: 'Jean-Hugues' });
  const msg = ctx.store.snapshot().messages.find(m => m.accountId === account.id);
  ctx.ms.calls.length = 0;
  return { ...ctx, account, outbox, msg };
}

test('brouillon de réponse : créé depuis le MIME exact (fil), puis mis à jour, recréé si supprimé', async () => {
  const { outbox, msg, ms, store } = await ready();
  const d = await outbox.saveDraft(msg.id, { text: 'Mardi 10h me va.', mode: 'replyAll' });
  assert.equal(d.synced, true);
  const create = ms.calls.find(c => c.method === 'POST' && c.path === 'me/messages');
  assert.equal(header(create.raw, 'To'), 'Claire Dubois <claire@atlas.fr>');
  assert.equal(header(create.raw, 'Cc'), 'Hugo <hugo@atlas.fr>');
  assert.equal(header(create.raw, 'In-Reply-To'), '<m1@atlas.fr>');
  assert.equal(header(create.raw, 'Subject'), 'Re: Atelier');
  const draftId = store.composeContext(msg.id).draftExternalId;
  await outbox.saveDraft(msg.id, { text: 'Version 2', mode: 'replyAll' });
  const patch = ms.calls.find(c => c.method === 'PATCH');
  assert.equal(patch.path, `me/messages/${draftId}`);
  assert.deepEqual(patch.body.body, { contentType: 'text', content: 'Version 2' });
  ms.messages.splice(ms.messages.findIndex(m => m.id === draftId), 1);
  await outbox.saveDraft(msg.id, { text: 'Version 3', mode: 'replyAll' });
  assert.notEqual(store.composeContext(msg.id).draftExternalId, draftId);
});

test('nouveau message : brouillon, aperçu exact, envoi par sendMail sans aucune lecture distante', async () => {
  const { outbox, ms, store, account } = await ready();
  const comp = store.createComposition(account.id);
  const input = { mode: 'new', text: 'Bonjour,\nVoici le devis.', to: 'Paul <paul@x.fr>, paul@x.fr', cc: 'jh@outlook.fr, Léa <lea@x.fr>', subject: 'Devis' };
  await outbox.saveDraft(comp.id, input);
  const p = await outbox.preview(comp.id, input);
  assert.deepEqual([p.to, p.cc, p.subject], [['Paul <paul@x.fr>'], ['=?UTF-8?B?TMOpYQ==?= <lea@x.fr>'], 'Devis']);
  assert.equal(p.from, 'Jean-Hugues <jh@outlook.fr>');
  assert.deepEqual(await outbox.send(comp.id, { ...input, digest: p.digest }), { sent: true, draftRemoved: false });
  assert.equal(ms.sent.length, 1);
  assert.equal(sha(ms.sent[0]), p.digest, 'exactement le MIME validé');
  assert.equal(bodyOf(ms.sent[0]), 'Bonjour,\r\nVoici le devis.');
  assert.ok(!ms.calls.some(c => c.method === 'GET' && c.path === 'me/messages'), 'aucune lecture de message distant');
  assert.ok(!ms.calls.some(c => /\/send$/.test(c.path)), 'jamais l’envoi d’un brouillon');
  await assert.rejects(outbox.saveDraft(store.createComposition(account.id).id, { ...input, mode: 'reply' }), e => e.status === 400);
});

test('revue : aperçu A puis B, envoi B, identifiant réutilisé : l’aperçu A n’envoie jamais', async () => {
  const { outbox, ms, store, account } = await ready();
  const comp = store.createComposition(account.id);
  const A = { mode: 'new', text: 'Version A', to: 'paul@x.fr', cc: '', subject: 'Devis' };
  const B = { ...A, text: 'Version B' };
  const pa = await outbox.preview(comp.id, A);
  const pb = await outbox.preview(comp.id, B);
  await outbox.send(comp.id, { ...B, digest: pb.digest });
  const again = store.createComposition(account.id);
  assert.equal(again.id, comp.id, 'SQLite réutilise l’identifiant');
  await assert.rejects(outbox.send(again.id, { ...A, digest: pa.digest }), e => e.code === 'confirmation_invalid');
  assert.equal(ms.sent.length, 1);
});

test('réponse : empreinte liée au fil, usage unique, double clic, refus net réutilisable, erreur incertaine consommée', async () => {
  const { outbox, msg, ms } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  await assert.rejects(outbox.send(msg.id, { ...input, text: 'autre', digest: p.digest }), e => e.code === 'digest_mismatch');
  ms.fail = (m, path) => path === 'me/sendMail'; ms.failStatus = 400;
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'provider');
  ms.failStatus = 503;
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'retryable');
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'confirmation_invalid');
  ms.fail = null;
  const p2 = await outbox.preview(msg.id, input);
  const r = await Promise.allSettled([outbox.send(msg.id, { ...input, digest: p2.digest }), outbox.send(msg.id, { ...input, digest: p2.digest })]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(ms.sent.length, 1);
  assert.equal(header(ms.sent[0], 'In-Reply-To'), '<m1@atlas.fr>');
});

test('permissions : sans Mail.Send, aperçu refusé ; sans Mail.ReadWrite, brouillon local', async () => {
  const { outbox, msg, ms } = await ready([`${G}Mail.Read`]);
  await assert.rejects(outbox.preview(msg.id, { text: 'x', mode: 'reply' }), e => e.status === 403);
  const d = await outbox.saveDraft(msg.id, { text: 'local', mode: 'reply' });
  assert.equal(d.synced, false);
  assert.equal(ms.calls.filter(c => c.method !== 'GET').length, 0);
});

test('déconnexion : compte et messages supprimés, aucune prétention de révocation', async () => {
  const { store, sync, account } = await ready();
  const r = await createOutlookDisconnect({ store, sync })(account.id);
  assert.equal(r.revoked, false);
  assert.match(r.consentUrls.personal, /account\.live\.com/);
  assert.equal(store.hasAccount(account.id), false);
  assert.equal(store.snapshot().messages.filter(m => m.accountId === account.id).length, 0);
});
