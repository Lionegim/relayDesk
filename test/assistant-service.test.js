import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createAssistantService } from '../src/mail/assistant-service.js';
import { createMailService } from '../src/mail/service.js';

function setup({ complete } = {}) {
  const db = openDatabase(':memory:'); seedIfEmpty(db);
  const store = createStore(db), calls = [], moves = [];
  const ai = { configured: true, model: 'test', complete: async (...args) => {
    calls.push(args); return complete ? complete(...args) : '• Résumé\nAction : vérifier';
  } };
  const mail = { updateMessage: async (id, patch) => { moves.push({ id, patch }); return store.updateMessage(id, patch); } };
  const assistant = createAssistantService({ store, ai, mail, ownerName: 'Jean-Hugues' });
  return { db, store, assistant, calls, moves };
}

test('résumé persistant réutilisé, nouvelle analyse après changement du fil', async () => {
  const { db, store, assistant, calls } = setup();
  const first = await assistant.run('summary', 1);
  assert.equal(first.cached, false);
  assert.equal((await assistant.run('summary', 1)).cached, true); assert.equal(calls.length, 1);
  store.updateMessage(1, { unread: false, flagged: true });
  assert.ok(assistant.results(1).summary, 'lu/drapeau ne changent pas le texte');
  db.prepare('UPDATE messages SET body = ? WHERE id = 1').run('Nouvelle réponse');
  assert.equal(assistant.results(1).summary, null);
  await assistant.run('summary', 1); assert.equal(calls.length, 2);
  await assistant.run('summary', 1, { regenerate: true }); assert.equal(calls.length, 3);
  assert.throws(() => assistant.results(999), e => e.status === 404); db.close();
});

test('réponse et analyse n’écrivent ni brouillon ni classement automatiquement', async () => {
  const { db, store, assistant, moves } = setup();
  const before = store.getMessage(1);
  assert.ok((await assistant.run('draft', 1, { tone: 'Cordial', intent: 'Demander un délai' })).text);
  assert.deepEqual(store.getMessage(1), before); assert.equal(moves.length, 0); db.close();
});

test('classement strict, dossier du profil, application explicite et refus des propositions périmées', async () => {
  const { db, store, assistant, moves } = setup({ complete: () => JSON.stringify({ category: 'action', priority: 'high', reason: 'Une réponse est attendue.', folder: 'D1' }) });
  const folders = store.aiFolders('anove');
  const result = await assistant.run('classify', 1);
  assert.equal(result.folderId, folders[0].id); assert.equal(moves.length, 0);
  await assert.rejects(assistant.apply(1, { proposalId: result.proposalId, folderId: store.aiFolders('perso')[0].id }), e => e.status === 400);
  await assert.rejects(assistant.apply(2, { proposalId: result.proposalId }), e => e.status === 409);
  const selectedFolder = folders[1].id;
  await assistant.apply(1, { proposalId: result.proposalId, folderId: selectedFolder });
  assert.equal(moves.length, 1); assert.equal(store.getMessage(1).folderId, selectedFolder);
  assert.equal(assistant.results(1).classify.folderId, selectedFolder);
  assert.equal(assistant.results(1).classify.suggestedFolderId, result.folderId);
  await assert.rejects(assistant.apply(1, { proposalId: result.proposalId }), e => e.status === 409);
  const next = await assistant.run('classify', 1, { regenerate: true });
  db.prepare('UPDATE messages SET body = ? WHERE id = 1').run('Nouveau contenu');
  await assert.rejects(assistant.apply(1, { proposalId: next.proposalId }), e => e.code === 'ai_stale');
  assert.equal(moves.length, 1); db.close();
});

test('suppression du compte purge les analyses ; résultat tardif rejeté', async () => {
  let release;
  const { db, store, assistant } = setup({ complete: () => new Promise(r => { release = r; }) });
  const job = assistant.run('summary', 1);
  db.prepare('UPDATE messages SET body = ? WHERE id = 1').run('Autre version');
  release('Résumé périmé'); await assert.rejects(job, e => e.code === 'ai_stale');
  assert.equal(store.getAIResult(1, 'summary'), null);
  db.close();
});

test('même conversation Gmail/Outlook : routes distinctes pour appliquer un classement', async () => {
  const { db, store } = setup();
  const hits = [];
  const provider = svc => ({ sync: { updateMessage: async (id, p) => { hits.push(svc); return store.updateMessage(id, p); }, permissions: () => ['read','labels'] } });
  const mail = createMailService({ store, providers: { gmail: provider('gmail'), outlook: provider('outlook') } });
  for (const svc of ['gmail', 'outlook']) {
    const a = store.upsertAccount('anove', { name: `Test ${svc}`, channel: 'email', svc, address: `${svc}@example.test` });
    const id = Number(db.prepare("INSERT INTO messages (profile_id,account_id,external_id,from_name,initials,handle,channel,account,sort_at,label,subject,preview,body,triage) VALUES ('anove',?,?,'A','A','a@example.test','email',?,1,'Information','Test','','Bonjour','')").run(a.id, 'thread', a.name).lastInsertRowid);
    const assistant = createAssistantService({ store, mail, ai: { model: 'test', complete: async () => JSON.stringify({ category: 'information', priority: 'normal', reason: 'À conserver.', folder: 'D1' }) } });
    const p = await assistant.run('classify', id);
    await assistant.apply(id, { proposalId: p.proposalId });
    store.deleteAccount(a.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_results WHERE message_id = ?').get(id).n, 0);
  }
  assert.deepEqual(hits, ['gmail','outlook']); db.close();
});


test('classement distant sans permission : refus avant toute mutation locale ou distante', async () => {
  const { db, store } = setup();
  const a = store.upsertAccount('anove', { name: 'Lecture seule', channel: 'email', svc: 'outlook', address: 'read@example.test' });
  db.prepare('UPDATE messages SET account_id = ?, external_id = ? WHERE id = 1').run(a.id, 'thread');
  let moved = false;
  const assistant = createAssistantService({ store, ai: { model: 'test', complete: async () => JSON.stringify({category:'information',priority:'normal',reason:'À lire.',folder:'D1'}) },
    mail: { permissions: () => ['read'], updateMessage: () => { moved = true; } } });
  const before = store.getMessage(1).folderId, r = await assistant.run('classify', 1);
  await assert.rejects(assistant.apply(1, {proposalId:r.proposalId}), e => e.status === 403);
  assert.equal(moved, false); assert.equal(store.getMessage(1).folderId, before);
  assert.equal(assistant.results(1).classify.appliedAt, null);
  db.close();
});
