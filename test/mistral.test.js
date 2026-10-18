import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMistralClient } from '../src/ai/mistral.js';

const msgs = [{ role: 'user', content: 'Bonjour' }];

test('sans clé : erreur 503 explicite, aucun appel réseau', async () => {
  let called = false;
  const ai = createMistralClient({ apiKey: '', model: 'm', fetchImpl: async () => { called = true; } });
  await assert.rejects(ai.complete(msgs), e => e.status === 503);
  assert.equal(called, false);
});

test('clé refusée et limite de débit', async () => {
  const withStatus = status => createMistralClient({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response('{}', { status }) });
  await assert.rejects(withStatus(401).complete(msgs), e => e.code === 'ai_auth');
  await assert.rejects(withStatus(429).complete(msgs), e => e.status === 429);
  await assert.rejects(withStatus(500).complete(msgs), e => e.status === 502);
});

test('réseau indisponible et réponse vide', async () => {
  const down = createMistralClient({ apiKey: 'k', model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.complete(msgs), e => e.code === 'ai_unreachable');
  const empty = createMistralClient({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response(JSON.stringify({ choices: [] })) });
  await assert.rejects(empty.complete(msgs), e => e.code === 'ai_empty');
});
