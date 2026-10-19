import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, connected } from './helpers/fake-google.js';
import { createGmailOutbox } from '../src/providers/gmail/outbox.js';
import { GMAIL_SCOPES } from '../src/providers/gmail/oauth.js';
import { createApp } from '../src/http/app.js';
import { createMistralClient } from '../src/ai/mistral.js';

const ALL = [GMAIL_SCOPES.read, GMAIL_SCOPES.drafts, GMAIL_SCOPES.send];
const decode = raw => Buffer.from(raw, 'base64url').toString('utf8');

async function ready(scopes = ALL) {
  const ctx = setup();
  const account = await connected(ctx, scopes);
  const outbox = createGmailOutbox({ store: ctx.store, sync: ctx.sync, ownerName: 'Jean-Hugues' });
  const msg = ctx.store.snapshot().messages.find(m => m.accountId === account.id);
  ctx.g.calls.length = 0;
  return { ...ctx, account, outbox, msg };
}

test('aperçu : contenu exact et empreinte SHA-256 du message construit', async () => {
  const { outbox, msg, g } = await ready();
  const p = await outbox.preview(msg.id, { text: 'Mardi 10h, parfait.', mode: 'reply' });
  assert.equal(p.from, 'Jean-Hugues <jh@gmail.com>');
  assert.deepEqual(p.to, ['Claire Dubois <claire@atlas.fr>']);
  assert.deepEqual(p.cc, []);
  assert.equal(p.subject, 'Re: Atelier');
  assert.equal(p.body, 'Mardi 10h, parfait.');
  assert.match(p.digest, /^[0-9a-f]{64}$/);
  assert.equal(g.sent.length, 0, 'l’aperçu n’envoie rien');
  assert.ok(!g.calls.some(c => c.method !== 'GET'), 'aucune écriture Gmail pendant l’aperçu');
});

test('envoi : seulement avec l’empreinte validée, dans le fil, puis brouillon effacé', async () => {
  const { outbox, msg, g, store } = await ready();
  const input = { text: 'Mardi 10h, parfait.', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  await assert.rejects(outbox.send(msg.id, input), e => e.status === 400, 'sans empreinte');
  await assert.rejects(outbox.send(msg.id, { ...input, digest: 'a'.repeat(64) }), e => e.code === 'digest_mismatch');
  await assert.rejects(outbox.send(msg.id, { ...input, text: 'Autre texte', digest: p.digest }), e => e.code === 'digest_mismatch');
  assert.equal(g.sent.length, 0);

  store.saveDraft(msg.id, 'brouillon local', { mode: 'reply' });
  await assert.rejects(outbox.send(msg.id,{...input,digest:p.digest}),e=>e.code==='draft_conflict');
  await outbox.preview(msg.id,input); // nouvel aperçu explicite après modification
  assert.deepEqual(await outbox.send(msg.id, { ...input, digest: p.digest }), { sent: true, draftRemoved: true }, 'aucun brouillon Gmail lié');
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].threadId, 't1');
  const mime = decode(g.sent[0].raw);
  assert.equal(createHash('sha256').update('thread:t1\n').update(mime).digest('hex'), p.digest, 'ce qui part est exactement ce qui a été validé, dans ce fil');
  assert.equal(store.getMessage(msg.id).draft, null);
  // Validation à usage unique : rejouer la même requête n'envoie rien.
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'confirmation_invalid');
  assert.equal(g.sent.length, 1);
  // Une empreinte correcte mais jamais émise par un aperçu est refusée.
  await assert.rejects(outbox.send(msg.id, { text: 'autre', mode: 'reply', digest: (await outbox.preview(msg.id, { text: 'autre', mode: 'reply' })).digest.replace(/^./, c => c === 'a' ? 'b' : 'a') }), e => e.code === 'digest_mismatch');
});

test('brouillon Gmail lié, même modifié hors de Relay : seul le MIME validé part, le brouillon Gmail est conservé', async () => {
  const { outbox, msg, g, store } = await ready();
  await outbox.saveDraft(msg.id, { text: 'ancienne version', mode: 'reply' });
  const external = { raw: Buffer.from('To: autre@x.fr\r\n\r\nmodifié dans Gmail').toString('base64url'), threadId: 't1' };
  g.drafts.d1 = external; // modification faite dans Gmail
  const input = { text: 'version validée', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  assert.deepEqual(await outbox.send(msg.id, { ...input, digest: p.digest }), { sent: true, draftRemoved: false });
  assert.equal(g.sent.length, 1);
  assert.ok(!g.calls.some(c => c.path.endsWith('drafts/send')), 'pas de drafts/send');
  assert.ok(!g.calls.some(c => c.method === 'DELETE'), 'aucune suppression distante');
  assert.equal(createHash('sha256').update('thread:t1\n').update(decode(g.sent[0].raw)).digest('hex'), p.digest);
  assert.deepEqual(g.drafts.d1, external, 'le brouillon Gmail reste intact');
  assert.equal(store.getMessage(msg.id).draft, null, 'brouillon local nettoyé');
});

test('revue P2 : aperçu → déconnexion → reconnexion (identifiants réutilisés) → ancienne empreinte refusée', async () => {
  const { createGmailDisconnect } = await import('../src/providers/gmail/disconnect.js');
  const ctx = await ready();
  const input = { text:'ok',mode:'reply' };
  const p = await ctx.outbox.preview(ctx.msg.id, input);
  await createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} })(ctx.account.id);
  const again = await connected(ctx, ALL);
  const msg2 = ctx.store.snapshot().messages.find(m => m.accountId === again.id);
  assert.equal(again.id, ctx.account.id, 'compte recréé avec le même identifiant');
  assert.equal(msg2.id, ctx.msg.id, 'message recréé avec le même identifiant');
  await assert.rejects(ctx.outbox.send(msg2.id, { ...input, digest: p.digest }), e => e.code === 'confirmation_invalid');
  assert.equal(ctx.g.sent.length, 0);
  // Une nouvelle vérification après la reconnexion permet l'envoi.
  const fresh = await ctx.outbox.preview(msg2.id, input);
  await ctx.outbox.send(msg2.id, { ...input, digest: fresh.digest });
  assert.equal(ctx.g.sent.length, 1);
});

test('double clic : un seul envoi', async () => {
  const { outbox, msg, g } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  const results = await Promise.allSettled([outbox.send(msg.id, { ...input, digest: p.digest }), outbox.send(msg.id, { ...input, digest: p.digest })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find(r => r.status === 'rejected').reason.code, /send_in_progress|already_sent/);
  assert.equal(g.sent.length, 1);
});

test('empreinte liée au fil : même texte, autre fil, refusé', async () => {
  const { outbox, msg, g, db } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  db.prepare('UPDATE messages SET external_id = ? WHERE id = ?').run('t2', msg.id);
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'digest_mismatch');
  assert.equal(g.sent.length, 0);
});

test('envoi refusé sans la permission Envoi, et message vide refusé', async () => {
  const { outbox, msg, g } = await ready([GMAIL_SCOPES.read, GMAIL_SCOPES.drafts]);
  await assert.rejects(outbox.preview(msg.id, { text: 'x', mode: 'reply' }), e => e.status === 403);
  await assert.rejects(outbox.send(msg.id, { text: 'x', mode: 'reply', digest: 'a'.repeat(64) }), e => e.status === 403);
  const full = await ready();
  await assert.rejects(full.outbox.preview(full.msg.id, { text: '   ', mode: 'reply' }), e => e.status === 400);
  assert.equal(g.sent.length + full.g.sent.length, 0);
});

test('nouvel élément dans le fil entre l’aperçu et l’envoi : refusé', async () => {
  const { outbox, msg, g, db } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  const p = await outbox.preview(msg.id, input);
  const meta = JSON.parse(db.prepare('SELECT reply_meta FROM messages WHERE id = ?').get(msg.id).reply_meta);
  db.prepare('UPDATE messages SET reply_meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, from: 'Autre <autre@x.fr>', messageId: '<t1b@x.fr>' }), msg.id);
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'digest_mismatch');
  assert.equal(g.sent.length, 0);
});

test('échec Gmail à l’envoi : brouillon conservé ; refus net réutilisable, erreur incertaine à revérifier', async () => {
  const { outbox, msg, g, store } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  store.saveDraft(msg.id, 'ok', { mode: 'reply' });
  let p = await outbox.preview(msg.id, input);
  // 5xx : Gmail a peut-être envoyé ; la validation est consommée.
  g.fail = (method, path) => method === 'POST' && path === 'messages/send';
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'retryable');
  assert.equal(store.getMessage(msg.id).draft.text, 'ok');
  g.fail = null;
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'confirmation_invalid');
  // 400 : refus net, aucun envoi ; la même validation peut resservir.
  p = await outbox.preview(msg.id, input);
  g.fail = (method, path) => method === 'POST' && path === 'messages/send';
  g.failStatus = 400;
  await assert.rejects(outbox.send(msg.id, { ...input, digest: p.digest }), e => e.code === 'gmail');
  g.fail = null;
  await outbox.send(msg.id, { ...input, digest: p.digest });
  assert.equal(g.sent.length, 1);
});

test('requêtes concurrentes depuis deux aperçus identiques : un seul envoi', async () => {
  const { outbox, msg, g } = await ready();
  const input = { text: 'ok', mode: 'reply' };
  const [a, b] = await Promise.all([outbox.preview(msg.id, input), outbox.preview(msg.id, input)]);
  assert.equal(a.digest, b.digest);
  const r = await Promise.allSettled([outbox.send(msg.id, { ...input, digest: a.digest }), outbox.send(msg.id, { ...input, digest: b.digest })]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(outbox.send(msg.id, { ...input, digest: a.digest }), e => e.code === 'confirmation_invalid');
  assert.equal(g.sent.length, 1);
});

test('routes HTTP : aperçu puis envoi', async () => {
  const ctx = await ready();
  const server = createApp({ store: ctx.store, ai: createMistralClient({ apiKey: '', model: 'm' }), ownerName: 'JH', gmail: { oauth: ctx.oauth, sync: ctx.sync, outbox: ctx.outbox, redirectUri: 'http://127.0.0.1/cb' } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const p = await (await post(`/api/messages/${ctx.msg.id}/send/preview`,{text:'ok',mode:'reply',baseVersion:ctx.store.getMessage(ctx.msg.id).draftVersion})).json();
    assert.match(p.digest, /^[0-9a-f]{64}$/);
    assert.equal((await post(`/api/messages/${ctx.msg.id}/send`, { text: 'ok!', mode: 'reply', digest: p.digest })).status, 409);
    assert.equal((await post(`/api/messages/${ctx.msg.id}/send`, { text: 'ok', mode: 'reply', digest: p.digest })).status, 200);
    assert.equal(ctx.g.sent.length, 1);
    // Un message de démonstration (sans compte Gmail) ne peut pas être envoyé.
    assert.equal((await post('/api/messages/1/send/preview',{text:'ok',mode:'reply',baseVersion:ctx.store.getMessage(1).draftVersion})).status, 403);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('mémoire Gmail : apprentissage seulement après succès, jamais brouillon, aperçu ou erreur incertaine',async()=>{
 const {outbox,msg,g,store,sync}=await ready();
 const input={text:'Mon style envoyé avec validation',mode:'reply'};
 const before=store.getReplyMemory(msg.id).sampleCount;
 await outbox.saveDraft(msg.id,input);const p=await outbox.preview(msg.id,input);
 assert.equal(store.getReplyMemory(msg.id).sampleCount,before);
 g.fail=(method,path)=>method==='POST'&&path==='messages/send';g.failStatus=503;
 await assert.rejects(outbox.send(msg.id,{...input,digest:p.digest}));assert.equal(store.getReplyMemory(msg.id).sampleCount,before);
 g.fail=null;const fresh=await outbox.preview(msg.id,input);await outbox.send(msg.id,{...input,digest:fresh.digest});
 assert.equal(store.getReplyMemory(msg.id).sampleCount,before+1);
 assert.ok(store.getReplyMemory(msg.id).examples.some(x=>x.text===input.text));sync.stop();
});

test('mémoire : effacement pendant un envoi Gmail en cours empêche son apprentissage tardif',async()=>{
 const {outbox,msg,g,store,sync}=await ready();const input={text:'Un envoi commencé avant effacement',mode:'reply'};
 const p=await outbox.preview(msg.id,input);
 g.fail=(method,path)=>{if(method==='POST'&&path==='messages/send')store.changeReplyMemory(msg.id,{reset:true});return false;};
 assert.equal((await outbox.send(msg.id,{...input,digest:p.digest})).sent,true);assert.equal(store.getReplyMemory(msg.id).sampleCount,0);sync.stop();
});

test('direct send rechecks AI provenance after waiting for the Gmail queue',async()=>{const{outbox,msg,g,store,sync,account}=await ready();const input={text:'Typed reply',mode:'reply'};const p=await outbox.preview(msg.id,input);let release;const blocked=sync.queue(account.id,()=>new Promise(r=>{release=r;}));await new Promise(setImmediate);const pending=outbox.send(msg.id,{...input,digest:p.digest,direct:true});store.markDraftAI(msg.id);release();await blocked;await assert.rejects(pending,e=>e.code==='preview_required');assert.equal(g.sent.length,0);});
