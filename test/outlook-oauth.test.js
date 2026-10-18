import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMicrosoftOAuth, grantedPermissions, normalizeScopes, OUTLOOK_SCOPES } from '../src/providers/outlook/oauth.js';
import { createGraphClient } from '../src/providers/outlook/api.js';
import { fakeMicrosoft, G, ALL_SCOPES } from './outlook-helpers.js';

const REDIRECT = 'http://localhost:4310/oauth/microsoft/callback';

test('non configuré : erreur explicite, aucun appel', () => {
  const oauth = createMicrosoftOAuth({ clientId: '', fetchImpl: async () => { throw new Error('appel'); } });
  assert.equal(oauth.configured, false);
  assert.throws(() => oauth.start({ redirectUri: REDIRECT, context: {} }), e => e.code === 'outlook_unconfigured');
});

test('autorisation : PKCE, client public sans secret, permissions progressives, state à usage unique', async () => {
  const ms = fakeMicrosoft({ scope: ALL_SCOPES });
  const oauth = createMicrosoftOAuth({ clientId: 'client-id', fetchImpl: ms.fetch });
  const url = new URL(oauth.start({ redirectUri: REDIRECT, context: { profileId: 'perso', address: 'jh@outlook.fr' }, perms: ['labels', 'send'] }));
  assert.equal(url.host, 'login.microsoftonline.com');
  assert.equal(url.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('login_hint'), 'jh@outlook.fr');
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'email', 'offline_access', `${G}User.Read`, `${G}Mail.Read`, `${G}Mail.ReadWrite`, `${G}Mail.Send`]);
  const lecture = new URL(oauth.start({ redirectUri: REDIRECT, context: {} })).searchParams.get('scope');
  assert.doesNotMatch(lecture, /ReadWrite|Send/, 'lecture seule par défaut');
  assert.throws(() => oauth.start({ redirectUri: REDIRECT, context: {}, perms: ['mcp'] }), e => e.code === 'oauth_scope');

  const state = url.searchParams.get('state');
  const r = await oauth.finish({ state, code: 'abc' });
  assert.equal(r.email, 'jh@outlook.fr');
  assert.equal(r.refreshToken, 'rt-rot-1');
  assert.deepEqual(grantedPermissions(r.scopes), ['read', 'labels', 'drafts', 'send']);
  const call = ms.tokenCalls[0];
  assert.equal(call.client_secret, undefined);
  assert.ok(call.code_verifier.length >= 43);
  await assert.rejects(oauth.finish({ state, code: 'abc' }), e => e.code === 'oauth_state');
});

test('permissions accordées : celles du jeton, pas celles demandées ; formats de scope variés', async () => {
  assert.deepEqual(normalizeScopes('https://graph.microsoft.com/Mail.Read MAIL.SEND openid'), ['mail.read', 'mail.send', 'openid']);
  assert.deepEqual(grantedPermissions(['Mail.ReadWrite']), ['read', 'labels', 'drafts']);
  assert.deepEqual(grantedPermissions([OUTLOOK_SCOPES.read]), ['read']);
  const ms = fakeMicrosoft(); // Microsoft n'accorde que Mail.Read
  const oauth = createMicrosoftOAuth({ clientId: 'c', fetchImpl: ms.fetch });
  const state = new URL(oauth.start({ redirectUri: REDIRECT, context: {}, perms: ['send'] })).searchParams.get('state');
  assert.deepEqual(grantedPermissions((await oauth.finish({ state, code: 'x' })).scopes), ['read']);
  const none = fakeMicrosoft({ scope: 'openid offline_access' });
  const o2 = createMicrosoftOAuth({ clientId: 'c', fetchImpl: none.fetch });
  const s2 = new URL(o2.start({ redirectUri: REDIRECT, context: {} })).searchParams.get('state');
  await assert.rejects(o2.finish({ state: s2, code: 'x' }), e => e.code === 'oauth_scope');
});

test('client Graph : rotation du jeton de rafraîchissement, jamais d’autre hôte, erreurs sans contenu', async () => {
  const ms = fakeMicrosoft();
  const rotated = [];
  const oauth = createMicrosoftOAuth({ clientId: 'c', fetchImpl: ms.fetch });
  const graph = createGraphClient({ refreshToken: 'rt-initial', oauth, fetchImpl: ms.fetch, onRotate: rt => rotated.push(rt) });
  assert.equal((await graph.me()).mail, 'jh@outlook.fr');
  assert.deepEqual(rotated, ['rt-rot-1']);
  await assert.rejects(graph.request('GET', 'https://evil.example/v1.0/me'), e => e.code === 'outlook');
  ms.fail = () => true; ms.failStatus = 400;
  await assert.rejects(graph.me(), e => e.code === 'provider' && !/secret/.test(e.message));
  ms.failStatus = 503;
  await assert.rejects(graph.me(), e => e.code === 'retryable');
  const revoked = createGraphClient({ refreshToken: 'revoked', oauth, fetchImpl: ms.fetch });
  await assert.rejects(revoked.me(), e => e.code === 'invalid_grant');
});
