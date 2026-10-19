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
  assert.deepEqual([p.to, p.cc, p.subject], [['Paul <paul@x.fr>'], ['jh@outlook.fr', '=?UTF-8?B?TMOpYQ==?= <lea@x.fr>'], 'Devis']);
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

const drafts = ms => ms.messages.filter(m => m.isDraft);

test('revue P2 : répondre enregistré puis transférer → brouillon recréé sans en-têtes de fil, ancien conservé', async () => {
  const { outbox, msg, ms, store } = await ready();
  await outbox.saveDraft(msg.id, { text: 'Réponse', mode: 'reply' });
  const first = store.composeContext(msg.id).draftExternalId;
  // Même rattachement (répondre → répondre à tous) : simple mise à jour.
  await outbox.saveDraft(msg.id, { text: 'À tous', mode: 'replyAll' });
  assert.equal(store.composeContext(msg.id).draftExternalId, first);
  assert.equal(drafts(ms).length, 1);
  // Enregistrement local intermédiaire (transfert sans adresse) : la clé du brouillon distant ne change pas.
  await outbox.saveDraft(msg.id, { text: 'Transfert', mode: 'forward', to: '' });
  ms.calls.length = 0;
  const r = await outbox.saveDraft(msg.id, { text: 'Transfert', mode: 'forward', to: 'paul@x.fr' });
  assert.equal(r.previousDraftKept, true);
  assert.ok(!ms.calls.some(c => c.method === 'PATCH'), 'jamais de PATCH sur un brouillon au mauvais fil');
  const created = ms.calls.find(c => c.method === 'POST' && c.path === 'me/messages').raw;
  assert.ok(!/^In-Reply-To:|^References:/m.test(created.split('\r\n\r\n')[0]), 'aucun en-tête de fil');
  assert.equal(header(created, 'Subject'), 'Fwd: Atelier');
  assert.notEqual(store.composeContext(msg.id).draftExternalId, first);
  assert.equal(drafts(ms).length, 2, 'ancien brouillon distant conservé');
  // Retour à répondre : nouveau rattachement, nouveau brouillon.
  await outbox.saveDraft(msg.id, { text: 'Finalement, réponse', mode: 'reply' });
  assert.equal(drafts(ms).length, 3);
});

test('revue P2 : nouveau message dans le fil → brouillon de réponse recréé avec le nouveau In-Reply-To', async () => {
  const { outbox, msg, ms, store } = await ready();
  await outbox.saveDraft(msg.id, { text: 'Réponse', mode: 'reply' });
  const reply = store.composeContext(msg.id).reply;
  store.setReplyMeta(msg.id, { ...reply, messageId: '<nouveau@atlas.fr>', references: `${reply.messageId}` });
  ms.calls.length = 0;
  const r = await outbox.saveDraft(msg.id, { text: 'Réponse', mode: 'reply' });
  assert.equal(r.previousDraftKept, true);
  const created = ms.calls.find(c => c.method === 'POST' && c.path === 'me/messages').raw;
  assert.equal(header(created, 'In-Reply-To'), '<nouveau@atlas.fr>');
  assert.equal(header(created, 'References'), `${reply.messageId} <nouveau@atlas.fr>`);
});

test('revue P2 : clé de rattachement persistée (migration 005) et relue après redémarrage', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { openDatabase } = await import('../src/db/index.js');
  const { createStore } = await import('../src/store.js');
  const { createVault } = await import('../src/secrets.js');
  const { createMicrosoftOAuth } = await import('../src/providers/outlook/oauth.js');
  const { createOutlookSync } = await import('../src/providers/outlook/sync.js');
  const { seedIfEmpty } = await import('../src/db/seed.js');
  const { fakeMicrosoft } = await import('./outlook-helpers.js');
  const dir = mkdtempSync(join(tmpdir(), 'relay-ol-'));
  const path = join(dir, 'relay.db');
  const ms = fakeMicrosoft();
  ms.add({ conversationId: 'C1', receivedDateTime: new Date(Date.now() - 3600000).toISOString() });
  const key = randomBytes(32);
  const boot = () => {
    const db = openDatabase(path);
    seedIfEmpty(db);
    const store = createStore(db);
    const oauth = createMicrosoftOAuth({ clientId: 'c', fetchImpl: ms.fetch });
    const sync = createOutlookSync({ store, vault: createVault(key), oauth, fetchImpl: ms.fetch, log: {} });
    return { db, store, sync, outbox: createOutlookOutbox({ store, sync, ownerName: 'JH' }) };
  };
  try {
    let app = boot();
    assert.ok(app.db.prepare('PRAGMA user_version').get().user_version >= 5);
    const { account, job } = app.sync.connect({ profileId: 'perso', name: 'Outlook JH', windowDays: 30, refreshToken: 'rt', email: 'jh@outlook.fr', scopes: ALL });
    await job;
    const id = app.store.snapshot().messages.find(m => m.accountId === account.id).id;
    await app.outbox.saveDraft(id, { text: 'v1', mode: 'reply' });
    // Enregistrement local : la clé du brouillon distant reste celle de la réponse.
    await app.outbox.saveDraft(id, { text: 'transfert', mode: 'forward', to: '' });
    const savedKey = app.store.composeContext(id).draftThreadKey;
    assert.match(savedKey, /^[0-9a-f]{64}$/);
    app.db.close();

    app = boot(); // redémarrage
    assert.equal(app.store.composeContext(id).draftThreadKey, savedKey);
    ms.calls.length = 0;
    await app.outbox.saveDraft(id, { text: 'v2', mode: 'reply' });
    assert.ok(ms.calls.some(c => c.method === 'PATCH'), 'même rattachement après redémarrage : mise à jour');
    assert.equal(drafts(ms).length, 1);
    app.store.clearDraft(id);
    assert.equal(app.store.composeContext(id).draftThreadKey, null);
    app.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mémoire Outlook : apprentissage seulement après sendMail confirmé, aucun apprentissage du brouillon ni erreur',async()=>{
 const {outbox,msg,ms,store,sync}=await ready();const input={text:'Merci pour ton retour, à bientôt !',mode:'reply'};
 const before=store.getReplyMemory(msg.id).sampleCount;
 await outbox.saveDraft(msg.id,input);const p=await outbox.preview(msg.id,input);assert.equal(store.getReplyMemory(msg.id).sampleCount,before);
 ms.fail=(method,path)=>path==='me/sendMail';ms.failStatus=503;await assert.rejects(outbox.send(msg.id,{...input,digest:p.digest}));assert.equal(store.getReplyMemory(msg.id).sampleCount,before);
 ms.fail=null;const fresh=await outbox.preview(msg.id,input);await outbox.send(msg.id,{...input,digest:fresh.digest});assert.equal(store.getReplyMemory(msg.id).sampleCount,before+1);sync.stop();
});

test('direct send accepts AI provenance without a second user confirmation in the Outlook queue',async()=>{const{outbox,msg,ms,store,sync,account}=await ready();const input={text:'Typed reply',mode:'reply'};const p=await outbox.preview(msg.id,input);let release;const blocked=sync.queue(account.id,()=>new Promise(r=>{release=r;}));await new Promise(setImmediate);const pending=outbox.send(msg.id,{...input,digest:p.digest,direct:true});store.markDraftAI(msg.id);release();await blocked;assert.equal((await pending).sent,true);assert.equal(ms.calls.filter(c=>c.path?.endsWith('/send') || c.path==='me/sendMail').length,1);});
