import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http/app.js';
import { createStore } from '../src/store.js';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createMistralClient } from '../src/ai/mistral.js';

let server, base, lastRequest;

const fakeFetch = async (url, init) => {
  lastRequest = { url, init, body: JSON.parse(init.body) };
  return new Response(JSON.stringify({ choices: [{ message: { content: '  • Résumé\nAction : valider  ' } }] }), { status: 200 });
};

before(async () => {
  const ai = createMistralClient({ apiKey: 'test-key', model: 'mistral-small-latest', fetchImpl: fakeFetch });
  const db = openDatabase(':memory:');
  seedIfEmpty(db);
  server = createApp({ store: createStore(db), ai, ownerName: 'Jean-Hugues' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));

const req = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

test('état initial : profils, messages, services', async () => {
  const { status, body } = await req('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(body.profiles.length, 3);
  assert.equal(body.messages.find(m => m.id === 1).count, 3);
  assert.equal(body.messages[0].body, undefined, 'le corps n’est pas dans l’état global');
  const full = await req('GET', '/api/messages/1');
  assert.equal(full.body.trail.length, 2);
  assert.match(full.body.body, /Bonjour Jean-Hugues/);
  assert.ok(body.services.gmail);
  assert.equal(body.ai.configured, true);
});

test('mise à jour d’un message et validation', async () => {
  assert.equal((await req('PATCH', '/api/messages/1', { flagged: false, unread: false })).body.flagged, false);
  assert.equal((await req('PATCH', '/api/messages/1', { unread: 'non' })).status, 400);
  assert.equal((await req('PATCH', '/api/messages/1', { folderId: 'f5' })).status, 400, 'dossier d’un autre profil');
  assert.equal((await req('PATCH', '/api/messages/999', { unread: true })).status, 404);
});

test('dossiers et sous-dossiers', async () => {
  const root = await req('POST', '/api/folders', { profileId: 'anove', name: 'Juridique', parentId: null });
  assert.equal(root.status, 200);
  const sub = await req('POST', '/api/folders', { profileId: 'anove', name: 'Contrats', parentId: root.body.id });
  assert.equal(sub.body.parent, root.body.id);
  assert.equal((await req('POST', '/api/folders', { profileId: 'anove', name: '  ' })).status, 400);
  assert.equal((await req('POST', '/api/folders', { profileId: 'anove', name: 'X', parentId: 'f6' })).status, 400);
});

test('brouillon enregistré', async () => {
  const { body } = await req('PUT', '/api/messages/2/draft', { text: 'Jeudi 10h me va.' });
  assert.equal(body.text, 'Jeudi 10h me va.');
  assert.ok(Date.parse(body.savedAt));
});

test('connexion simulée d’un compte', async () => {
  const { body } = await req('POST', '/api/profiles/anove/accounts', { name: 'WhatsApp pro', svc: 'whatsapp' });
  assert.equal(body.status, 'Connecté');
  assert.equal((await req('POST', '/api/profiles/anove/accounts', { name: 'LinkedIn', svc: 'linkedin' })).status, 400);
});

test('résumé IA : le fil est construit côté serveur et balisé', async () => {
  const { status, body } = await req('POST', '/api/ai/summary', { messageId: 1 });
  assert.equal(status, 200);
  assert.equal(body.text, '• Résumé\nAction : valider');
  assert.equal(lastRequest.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(lastRequest.init.headers.authorization, 'Bearer test-key');
  const user = lastRequest.body.messages[1].content;
  assert.match(user, /<fil>[\s\S]*Marina Volgina \(Mar\. 17:45\)[\s\S]*Marina Volgina \(16:08\)[\s\S]*<\/fil>/);
  assert.equal(lastRequest.body.messages[0].role, 'system');
});

test('brouillon IA : ton et intention validés', async () => {
  assert.equal((await req('POST', '/api/ai/draft', { messageId: 2, tone: 'Formel', intent: 'accepter jeudi' })).status, 200);
  assert.match(lastRequest.body.messages[1].content, /Ton : Formel\. Intention : accepter jeudi\./);
  assert.equal((await req('POST', '/api/ai/draft', { messageId: 2, tone: 'Agressif' })).status, 400);
});

test('erreurs HTTP en JSON, statique protégé', async () => {
  assert.equal((await req('GET', '/api/nope')).status, 404);
  assert.equal((await req('DELETE', '/api/state')).status, 405);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
  const bad = await fetch(base + '/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
});
