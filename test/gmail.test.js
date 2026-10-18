import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/secrets.js';
import { createGoogleOAuth, GMAIL_SCOPES } from '../src/providers/gmail/oauth.js';
import { createGmailClient } from '../src/providers/gmail/api.js';
import { createGmailSync } from '../src/providers/gmail/sync.js';
import { threadToRecord, decodeWords, htmlToText, stripQuoted } from '../src/providers/gmail/parse.js';
import { createApp } from '../src/http/app.js';
import { createMistralClient } from '../src/ai/mistral.js';

const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64url');
const msg = ({ id, from, subject = 'Devis atelier', date, labels = ['INBOX'], text, html, charset = 'utf-8', snippet = '' }) => ({
  id, threadId: 't1', labelIds: labels, snippet, internalDate: String(date),
  payload: {
    mimeType: 'multipart/alternative',
    headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }],
    parts: [
      text != null && { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }], body: { data: b64(text, charset === 'iso-8859-1' ? 'latin1' : 'utf8') } },
      html != null && { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { data: b64(html) } },
    ].filter(Boolean),
  },
});

const THREAD = {
  id: 't1',
  messages: [
    msg({ id: 'a', from: 'Moi <jh@gmail.com>', date: 1000, labels: ['SENT'], text: 'Bonjour Claire, voici le devis.' }),
    msg({ id: 'b', from: '"Claire Dubois" <claire@atlas.fr>', date: 2000, labels: ['INBOX', 'UNREAD', 'IMPORTANT', 'Label_7'], snippet: 'C&#39;est valid&eacute;',
      html: '<div>C’est validé.<br>Merci&nbsp;!</div><style>p{}</style><div>Le 3 oct. 2026, Moi a écrit :</div><blockquote>&gt; Bonjour</blockquote>' }),
  ],
};

test('parse : fil Gmail vers ligne Relay', () => {
  const r = threadToRecord(THREAD, { ownEmail: 'jh@gmail.com', labelNames: { Label_7: 'Clients' } });
  assert.equal(r.from, 'Claire Dubois');
  assert.equal(r.handle, 'claire@atlas.fr');
  assert.equal(r.initials, 'CD');
  assert.equal(r.preview, 'C\'est validé');
  assert.equal(r.body, 'C’est validé.\nMerci !');
  assert.deepEqual([r.unread, r.flagged, r.archived, r.count], [true, false, false, 2]);
  assert.equal(r.trail[0].from, 'Moi');
  assert.equal(r.labelId, 'Label_7');
  assert.equal(r.label, 'À traiter');
});

test('parse : en-têtes encodés, latin-1, citations, corbeille', () => {
  assert.equal(decodeWords('=?UTF-8?B?w4l0w6k=?= =?ISO-8859-1?Q?caf=E9?='), 'Étécafé');
  const latin = threadToRecord({ id: 't2', messages: [msg({ id: 'x', from: 'a@b.fr', date: 1, text: 'Réunion à 10h', charset: 'iso-8859-1' })] }, { ownEmail: 'me@x' });
  assert.equal(latin.body, 'Réunion à 10h');
  assert.equal(stripQuoted('Oui.\n\nOn Mon, Bob wrote:\n> hello'), 'Oui.');
  assert.equal(htmlToText('<p>a</p><script>x()</script><p>b &amp; c</p>'), 'a\nb & c');
  assert.equal(threadToRecord({ id: 't3', messages: [msg({ id: 'y', from: 'a@b', date: 1, labels: ['TRASH'], text: 'x' })] }, { ownEmail: '' }), null);
});

test('coffre : chiffrement lié au compte', () => {
  const vault = createVault(randomBytes(32));
  const sealed = vault.seal(4, { refreshToken: 'r1' });
  assert.ok(!sealed.ciphertext.toString().includes('r1'));
  assert.deepEqual(vault.open(4, sealed), { refreshToken: 'r1' });
  assert.throws(() => vault.open(5, sealed), 'un secret ne se déchiffre pas pour un autre compte');
});

// Faux Google : jeton, profil, libellés, fils, historique.
function fakeGoogle() {
  const g = { threads: { t1: structuredClone(THREAD) }, history: [], historyId: '100', historyGone: false, tokenCalls: [], requests: [],
    scopes: 'openid ' + GMAIL_SCOPES.read, modifyStatus: 200, labelStatus: 200, labels: [{ id: 'Label_7', name: 'Clients', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }] };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.host === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(String(init.body));
      g.tokenCalls.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        const idToken = `x.${b64(JSON.stringify({ email: 'jh@gmail.com' }))}.y`;
        return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt-secret', scope: g.scopes, id_token: idToken });
      }
      return json({ access_token: 'at2', expires_in: 3600 });
    }
    assert.equal(init.headers.authorization.startsWith('Bearer '), true);
    const path = u.pathname.replace('/gmail/v1/users/me/', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    g.requests.push({ path, method, body });
    if (g.beforeRequest) await g.beforeRequest({ path, method, body });
    const failure = g.failures?.[path]?.shift();
    if (failure) return json({}, failure);
    if (method === 'POST' && path === 'labels') {
      if (g.labelStatus !== 200) return json({}, g.labelStatus);
      if (g.labels.some(l => l.name === body.name)) return json({}, 409);
      const label = { id: 'Label_' + (g.labels.length + 100), name: body.name, type: 'user' };
      g.labels.push(label);
      return json(label);
    }
    if (method === 'POST' && path.endsWith('/modify')) {
      if (g.modifyStatus !== 200) return json({}, g.modifyStatus);
      const id = decodeURIComponent(path.split('/')[1]);
      const thread = g.threads[id];
      if (!thread) return json({}, 404);
      for (const message of thread.messages) message.labelIds = [...new Set([...message.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
      g.historyId = String(Number(g.historyId) + 1);
      g.history = [{ labelsAdded: [{ message: { threadId: id }, labelIds: body.addLabelIds }], labelsRemoved: [{ message: { threadId: id }, labelIds: body.removeLabelIds }] }];
      return json(thread);
    }
    if (path === 'profile') return json({ emailAddress: 'jh@gmail.com', historyId: g.historyId });
    if (path === 'labels') return json({ labels: g.labels });
    if (path === 'threads') return json({ threads: Object.keys(g.threads).map(id => ({ id })) });
    if (path.startsWith('threads/')) {
      const t = g.threads[decodeURIComponent(path.slice(8))];
      return t ? json(t) : json({ error: {} }, 404);
    }
    if (path === 'history') return g.historyGone ? json({ error: {} }, 404) : json({ history: g.history, historyId: g.historyId });
    return json({ error: {} }, 404);
  };
  return g;
}

function setup() {
  const db = openDatabase(':memory:');
  seedIfEmpty(db);
  const store = createStore(db);
  const g = fakeGoogle();
  const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'csecret', fetchImpl: g.fetch });
  const vault = createVault(randomBytes(32));
  const sync = createGmailSync({ store, vault, oauth, fetchImpl: g.fetch, log: {} });
  return { db, store, g, oauth, sync, vault };
}

test('synchronisation : import initial puis incrémental', async () => {
  const { store, g, sync, db } = setup();
  const { account, job } = sync.connect({ profileId: 'perso', name: 'Gmail perso', windowDays: 30, refreshToken: 'rt-secret', email: 'jh@gmail.com' });
  await job;
  assert.equal(store.getAccount(account.id).status, 'Connecté');
  const p = sync.progress(account.id);
  assert.deepEqual([p.status, p.total, p.done, p.threads, p.messages, p.todo], ['ok', 1, 1, 1, 2, 1]);
  const row = store.snapshot().messages.find(m => m.accountId === account.id);
  assert.equal(row.p, 'perso');
  assert.equal(store.snapshot().folders.find(f => f.id === row.folderId).name, 'Clients');
  assert.ok(!db.prepare('SELECT ciphertext FROM secrets').get().ciphertext.toString().includes('rt-secret'), 'jeton chiffré au repos');

  // Le fil est lu ailleurs, et un nouveau fil arrive.
  g.threads.t1 = { ...THREAD, messages: THREAD.messages.map(m => ({ ...m, labelIds: m.labelIds.filter(l => l !== 'UNREAD') })) };
  g.threads.t9 = { id: 't9', messages: [msg({ id: 'z', from: 'Lettre <news@x.fr>', date: 3000, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], text: 'Promo' })] };
  g.history = [{ messages: [{ threadId: 't1' }] }, { messages: [{ threadId: 't9' }] }];
  g.historyId = '120';
  await sync.syncNow(account.id);
  const rows = store.snapshot().messages.filter(m => m.accountId === account.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(m => m.subject === 'Devis atelier').unread, false);
  assert.equal(rows.find(m => m.from === 'Lettre').label, 'Newsletter');
  assert.equal(store.getSync(account.id).history_id, '120');

  // Fil supprimé, puis historique expiré : réimport complet.
  delete g.threads.t9;
  g.history = [{ messages: [{ threadId: 't9' }] }];
  await sync.syncNow(account.id);
  assert.equal(store.snapshot().messages.filter(m => m.accountId === account.id).length, 1);
  g.historyGone = true;
  g.historyId = '200';
  await sync.syncNow(account.id);
  assert.equal(store.getSync(account.id).history_id, '200');
});

test('synchronisation : accès révoqué', async () => {
  const { store, g, sync } = setup();
  const { account, job } = sync.connect({ profileId: 'perso', name: 'Gmail perso', windowDays: 7, refreshToken: 'rt', email: 'jh@gmail.com' });
  await job;
  const real = g.fetch;
  g.fetch = async (url, init) => (String(url).includes('oauth2') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : real(url, init));
  // Nouveau client sans jeton d'accès en cache.
  const { sync: sync2 } = { sync: createGmailSync({ store, vault: { open: () => ({ refreshToken: 'rt', email: 'jh@gmail.com' }) }, oauth: createGoogleOAuth({ clientId: 'c', clientSecret: 's', fetchImpl: g.fetch }), fetchImpl: g.fetch, log: {} }) };
  await sync2.syncNow(account.id);
  assert.equal(store.getAccount(account.id).status, 'À reconnecter');
});

test('autorisation : PKCE, state à usage unique, redirection', async () => {
  const { store, g, oauth, sync } = setup();
  const server = createApp({ store, ai: createMistralClient({ apiKey: '', model: 'm' }), ownerName: 'JH', gmail: { oauth, sync, redirectUri: 'http://127.0.0.1:4310/oauth/google/callback' } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${base}/oauth/google/start?profile=perso&name=Gmail%20perso&win=30`, { redirect: 'manual' });
    const auth = new URL(start.headers.get('location'));
    assert.equal(auth.host, 'accounts.google.com');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.match(auth.searchParams.get('scope'), /gmail\.readonly/);
    assert.doesNotMatch(auth.searchParams.get('scope'), /mail\.google\.com|gmail\.modify|gmail\.send/);
    const state = auth.searchParams.get('state');

    const cb = await fetch(`${base}/oauth/google/callback?state=${state}&code=abc`, { redirect: 'manual' });
    const back = new URL(cb.headers.get('location'), base);
    assert.equal(back.searchParams.get('connect'), 'gmail');
    const tokenCall = g.tokenCalls.find(c => c.grant_type === 'authorization_code');
    assert.ok(tokenCall.code_verifier.length >= 43);

    const replay = await fetch(`${base}/oauth/google/callback?state=${state}&code=abc`, { redirect: 'manual' });
    assert.match(new URL(replay.headers.get('location'), base).searchParams.get('connect_error'), /expirée ou inconnue/);

    const bad = await fetch(`${base}/oauth/google/start?profile=nope&name=x&win=30`, { redirect: 'manual' });
    assert.ok(new URL(bad.headers.get('location'), base).searchParams.get('connect_error'));

    const id = back.searchParams.get('account');
    let progress;
    for (let i = 0; i < 50 && progress?.status !== 'ok'; i++) {
      progress = await (await fetch(`${base}/api/accounts/${id}/sync`)).json();
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(progress.status, 'ok');
    const state2 = await (await fetch(`${base}/api/state`)).json();
    assert.ok(!JSON.stringify(state2).includes('rt-secret'), 'le jeton ne sort jamais par l’API');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('hôte non autorisé refusé', async () => {
  const { store } = setup();
  const server = createApp({ store, ai: createMistralClient({ apiKey: '', model: 'm' }), ownerName: 'JH', allowedHosts: ['127.0.0.1:1'] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
  assert.equal(res.status, 403);
  await new Promise(r => server.close(r));
});

async function connected(t, scopes = [GMAIL_SCOPES.read, GMAIL_SCOPES.labels]) {
  const ctx = setup();
  const { account, job } = ctx.sync.connect({ profileId: 'perso', name: 'Gmail réel', windowDays: 7, refreshToken: 'rt-secret', email: 'jh@gmail.com', scopes });
  await job;
  ctx.account = account;
  ctx.message = ctx.store.snapshot().messages.find(m => m.accountId === account.id);
  t.after(() => { ctx.sync.stop(); ctx.db.close(); });
  return ctx;
}

async function serve(t, ctx) {
  const server = createApp({ store: ctx.store, ai: createMistralClient({ apiKey: '', model: 'm' }), ownerName: 'JH', gmail: { oauth: ctx.oauth, sync: ctx.sync, redirectUri: 'http://127.0.0.1:4310/oauth/google/callback' } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, redirect: 'manual', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: res.status, headers: res.headers, body: res.status === 302 ? null : await res.json() };
  };
}

const writes = g => g.requests.filter(r => r.method === 'POST');

test('lot A : lu/non lu, drapeau et archivage sont appliqués au fil avant SQLite', async t => {
  const { store, sync, g, message } = await connected(t);
  for (const [patch, addLabelIds, removeLabelIds] of [
    [{ unread: false }, [], ['UNREAD']], [{ unread: true }, ['UNREAD'], []],
    [{ flagged: true }, ['STARRED'], []], [{ flagged: false }, [], ['STARRED']],
    [{ archived: true }, [], ['INBOX']], [{ archived: false }, ['INBOX'], []],
  ]) {
    const before = store.getMessage(message.id);
    g.beforeRequest = ({ method }) => { if (method === 'POST') assert.deepEqual(store.getMessage(message.id), before); };
    const result = await sync.updateMessage(message.id, patch);
    assert.deepEqual(writes(g).at(-1), { method: 'POST', path: 'threads/t1/modify', body: { addLabelIds, removeLabelIds } });
    for (const [key, value] of Object.entries(patch)) assert.equal(result[key], value);
    g.beforeRequest = null;
    await sync.syncNow(message.accountId);
    for (const [key, value] of Object.entries(patch)) assert.equal(store.getMessage(message.id)[key], value, 'history.list ne rétablit pas l’ancien état');
  }
});

test('lot A : dossier imbriqué, création du libellé et retrait de l’ancien', async t => {
  const { store, sync, g, message, account } = await connected(t);
  const parent = store.createFolder({ profileId: 'perso', name: 'Projets' });
  const folder = store.createFolder({ profileId: 'perso', name: 'Été', parentId: parent.id });
  const before = store.getMessage(message.id);
  g.beforeRequest = ({ method }) => {
    if (method === 'POST') {
      assert.equal(store.getMessage(message.id).folderId, before.folderId);
      assert.equal(store.folderLabel(folder.id, account.id), null);
    }
  };
  await sync.updateMessage(message.id, { folderId: folder.id, unread: false, flagged: true });
  const labelId = store.folderLabel(folder.id, account.id);
  assert.ok(labelId);
  assert.deepEqual(writes(g).at(-2), { method: 'POST', path: 'labels', body: { name: 'Projets/Été' } });
  assert.deepEqual(writes(g).at(-1).body, { addLabelIds: ['STARRED', labelId], removeLabelIds: ['UNREAD', 'Label_7'] });
  g.beforeRequest = null;
  // D'autres libellés peuvent précéder le dossier choisi : il doit rester sélectionné.
  g.labels.push({ id: 'Other', name: 'Autre', type: 'user' });
  for (const m of g.threads.t1.messages) m.labelIds.unshift('Other');
  await sync.syncNow(account.id);
  assert.equal(store.getMessage(message.id).folderId, folder.id);
  assert.equal(store.snapshot().folders.find(f => f.id === folder.id).name, 'Été');
  // Retirer les autres libellés de la fixture pour vérifier « Aucun dossier ».
  for (const m of g.threads.t1.messages) m.labelIds = m.labelIds.filter(l => l !== 'Other');
  await sync.updateMessage(message.id, { folderId: null });
  assert.deepEqual(writes(g).at(-1).body, { addLabelIds: [], removeLabelIds: [labelId] });
  await sync.syncNow(account.id);
  assert.equal(store.getMessage(message.id).folderId, null);
});

test('lot A : libellé déjà lié réutilisé, 409 résolu par son nom', async t => {
  const { store, sync, g, message, account } = await connected(t);
  const folder = store.createFolder({ profileId: 'perso', name: 'Archives projet' });
  g.labels.push({ id: 'Existing', name: 'Archives projet', type: 'user' });
  await sync.updateMessage(message.id, { folderId: folder.id });
  assert.equal(store.folderLabel(folder.id, account.id), 'Existing');
  assert.ok(g.requests.some(r => r.path === 'labels' && r.method === 'GET'));
  await sync.updateMessage(message.id, { folderId: message.folderId });
  assert.deepEqual(writes(g).at(-1).body, { addLabelIds: ['Label_7'], removeLabelIds: ['Existing'] });
  const createCount = writes(g).filter(r => r.path === 'labels').length;
  await sync.updateMessage(message.id, { folderId: folder.id });
  assert.equal(writes(g).filter(r => r.path === 'labels').length, createCount);
});

test('lot A : aucun appel Gmail sans labels, y compris avec un ancien secret', async t => {
  const { store, sync, g, vault, message, account } = await connected(t, [GMAIL_SCOPES.read]);
  // Simule une base de la version lecture seule, sans champ scopes.
  store.putSecret(account.id, vault.seal(account.id, { refreshToken: 'rt-secret', email: 'jh@gmail.com' }));
  assert.deepEqual(sync.permissions(account.id), ['read']);
  const folder = store.createFolder({ profileId: 'perso', name: 'Local' });
  const count = g.requests.length;
  await sync.updateMessage(message.id, { unread: false, flagged: true, archived: true, folderId: folder.id });
  assert.equal(g.requests.length, count);
  assert.equal(store.getMessage(message.id).folderId, folder.id);
  assert.equal(store.folderLabel(folder.id, account.id), null);
});

test('lot A : validation avant réseau et erreurs Gmail → 502 sans écriture locale', async t => {
  const ctx = await connected(t);
  const { store, g, message, account, db } = ctx;
  const req = await serve(t, ctx);
  const folder = store.createFolder({ profileId: 'perso', name: 'Nouveau' });
  const foreign = store.createFolder({ profileId: 'anove', name: 'Autre profil' });
  for (const patch of [{ unread: 'non' }, { flagged: 1 }, { archived: null }, { folderId: foreign.id }, { folderId: 'inconnu' }, { unread: false, folderId: foreign.id }]) {
    const count = g.requests.length;
    assert.equal((await req('PATCH', `/api/messages/${message.id}`, patch)).status, 400);
    assert.equal(g.requests.length, count);
  }
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const before = store.getMessage(message.id);
    const links = db.prepare('SELECT * FROM folder_labels').all();
    g.modifyStatus = status;
    const r = await req('PATCH', `/api/messages/${message.id}`, { unread: false, flagged: true, archived: true, folderId: folder.id });
    assert.equal(r.status, 502, `statut Gmail ${status}`);
    assert.deepEqual(store.getMessage(message.id), before);
    assert.deepEqual(db.prepare('SELECT * FROM folder_labels').all(), links);
    assert.equal(store.folderLabel(folder.id, account.id), null);
  }
  g.modifyStatus = 200;
  g.labelStatus = 403;
  assert.equal((await req('PATCH', `/api/messages/${message.id}`, { folderId: folder.id })).status, 502);
  assert.equal(store.getMessage(message.id).folderId, message.folderId);
});

test('client REST : POST rejoué une seule fois après 401, mêmes données JSON', async () => {
  const g = fakeGoogle();
  g.failures = { 'threads/t1/modify': [401] };
  const oauth = createGoogleOAuth({ clientId: 'c', clientSecret: 's', fetchImpl: g.fetch });
  const gmail = createGmailClient({ refreshToken: 'r', oauth, fetchImpl: g.fetch, initialAccess: { token: 'cached', expiresAt: Date.now() + 3600000 } });
  const body = { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] };
  await gmail.post('threads/t1/modify', body);
  assert.equal(g.tokenCalls.length, 1);
  assert.deepEqual(writes(g).map(r => r.body), [body, body]);
  g.failures = { 'threads/t1/modify': [401, 401] };
  await assert.rejects(gmail.post('threads/t1/modify', body), e => e.status === 502);
  assert.equal(writes(g).length, 4);
  for (const [status, code] of [[404, 'not_found'], [429, 'retryable'], [503, 'retryable']]) {
    g.failures = { 'threads/t1/modify': [status] };
    await assert.rejects(gmail.post('threads/t1/modify', body), e => e.code === code);
  }
  const offline = createGmailClient({ refreshToken: 'r', oauth, fetchImpl: async () => { throw new Error('offline'); }, initialAccess: { token: 'cached', expiresAt: Date.now() + 3600000 } });
  await assert.rejects(offline.post('labels', { name: 'A' }), e => e.code === 'retryable');
});

test('permissions : demande progressive, scopes effectivement accordés et secret chiffré', async t => {
  const ctx = await connected(t, [GMAIL_SCOPES.read]);
  const { g, sync, store, vault, account } = ctx;
  const req = await serve(t, ctx);
  const start = await req('GET', '/oauth/google/start?profile=perso&name=Gmail%20r%C3%A9el&win=7&perms=read,labels&account=' + account.id);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'true');
  assert.deepEqual(auth.searchParams.get('scope').split(' '), ['openid', 'email', GMAIL_SCOPES.read, GMAIL_SCOPES.labels]);
  assert.doesNotMatch(auth.searchParams.get('scope'), /mail\.google\.com|gmail\.compose|gmail\.send/);
  // Google n'accorde que read : ne jamais déduire labels de ce qui a été demandé.
  const cb = await req('GET', '/oauth/google/callback?state=' + auth.searchParams.get('state') + '&code=abc');
  assert.equal(new URL(cb.headers.get('location'), 'http://localhost').searchParams.get('connect'), 'gmail');
  assert.deepEqual(sync.permissions(account.id), ['read']);
  const secret = vault.open(account.id, store.getSecret(account.id));
  assert.deepEqual(secret.scopes, g.scopes.split(' '));
  let state = (await req('GET', '/api/state')).body;
  assert.deepEqual(state.profiles.find(p => p.id === 'perso').accounts.find(a => a.id === account.id).perms, ['read']);
  assert.ok(!JSON.stringify(state).includes('rt-secret'));
  // Lot C : drafts devient disponible ; send reste refusé jusqu'au lot D.
  for (const bad of ['labels,unknown', 'read,,labels', 'send', 'https://mail.google.com/']) {
    const r = await req('GET', '/oauth/google/start?profile=perso&name=x&win=7&perms=' + encodeURIComponent(bad));
    assert.match(new URL(r.headers.get('location'), 'http://localhost').searchParams.get('connect_error'), /Permission/);
  }
  g.scopes = 'openid ' + GMAIL_SCOPES.labels; // Google peut inclure la lecture dans modify.
  const again = await req('GET', '/oauth/google/start?profile=perso&name=Gmail%20r%C3%A9el&win=7&perms=read,labels');
  const stateParam = new URL(again.headers.get('location')).searchParams.get('state');
  await req('GET', '/oauth/google/callback?state=' + stateParam + '&code=abc');
  assert.deepEqual(sync.permissions(account.id), ['read', 'labels']);
  state = (await req('GET', '/api/state')).body;
  assert.deepEqual(state.profiles.find(p => p.id === 'perso').accounts.find(a => a.id === account.id).perms, ['read', 'labels']);
});

test('migration 002 : préserve les liens existants et accepte plusieurs comptes par dossier', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'relay.db');
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('../src/db/migrations/001_init.sql', import.meta.url), 'utf8'));
  old.exec("PRAGMA user_version = 1; INSERT INTO profiles(id,name,kind,initials) VALUES ('perso','Personnel','perso','JH'); INSERT INTO accounts(id,profile_id,name,channel,status) VALUES (1,'perso','G1','email','Connecté'),(2,'perso','G2','email','Connecté'); INSERT INTO folders(id,profile_id,name,account_id,external_id) VALUES ('old','perso','Clients',1,'Label_old');");
  old.close();
  const db = openDatabase(path), store = createStore(db);
  t.after(() => db.close());
  assert.equal(store.folderLabel('old', 1), 'Label_old');
  store.linkFolderLabel('old', 2, 'Label_other');
  assert.equal(store.folderLabel('old', 2), 'Label_other');
  assert.equal(store.ensureLabelFolder(1, 'Label_old', 'Clients'), 'old');
  assert.equal(store.ensureLabelFolder(2, 'Label_other', 'Clients'), 'old');
  assert.equal(store.snapshot().folders.length, 1);
});

test('lot A : actions et synchronisations du même compte restent ordonnées', async t => {
  const { sync, store, g, message, account } = await connected(t);
  let release, entered;
  const waiting = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let paused = false;
  g.beforeRequest = async ({ path }) => {
    if (path === 'history' && !paused) { paused = true; entered(); await waiting; }
  };
  const read = sync.syncNow(account.id);
  await started;
  const write = sync.updateMessage(message.id, { unread: false, flagged: true });
  assert.equal(writes(g).length, 0, 'l’action attend la synchronisation en cours');
  release();
  await Promise.all([read, write]);
  await sync.syncNow(account.id);
  assert.equal(store.getMessage(message.id).unread, false);
  assert.equal(store.getMessage(message.id).flagged, true);
});

test('synchronisation en erreur : attend tous les fils avant de libérer les écritures', async t => {
  const { store, sync, g, vault, oauth, account } = await connected(t);
  g.threads.t2 = { ...structuredClone(THREAD), id: 't2' };
  g.history = [{ messages: [{ threadId: 't2' }] }];
  await sync.syncNow(account.id);
  // Retrouve t2 sans supposer l'ordre des lignes.
  const id = store.db.prepare("SELECT id FROM messages WHERE account_id = ? AND external_id = 't2'").get(account.id).id;
  let release, entered;
  const waiting = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let pause = true;
  const sync2 = createGmailSync({ store, vault, oauth, log: {}, fetchImpl: async (url, init) => {
    const response = await g.fetch(url, init);
    if (pause && new URL(url).pathname.endsWith('/threads/t2')) {
      pause = false;
      entered();
      await waiting; // La réponse contient encore l'ancien état.
    }
    return response;
  } });
  g.failures = { 'threads/t1': [503] };
  g.history = [{ messages: [{ threadId: 't1' }, { threadId: 't2' }] }];
  const read = sync2.syncNow(account.id);
  await started;
  const count = writes(g).length;
  const write = sync2.updateMessage(id, { flagged: true });
  await new Promise(setImmediate);
  assert.equal(writes(g).length, count, 'aucune écriture tant qu’un ancien import reste en vol');
  release();
  await Promise.all([read, write]);
  assert.equal(store.getMessage(id).flagged, true);
});

test('réautorisation pendant une synchronisation : nouvelles permissions et réimport ordonnés', async t => {
  const { store, sync, g, account, vault } = await connected(t, [GMAIL_SCOPES.read]);
  let release, entered;
  const waiting = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let pause = true;
  g.beforeRequest = async ({ path }) => {
    if (path === 'history' && pause) { pause = false; entered(); await waiting; }
  };
  const oldSync = sync.syncNow(account.id);
  await started;
  const { job } = sync.connect({ profileId: 'perso', name: 'Gmail réel', windowDays: 90, refreshToken: 'new-rt', email: 'jh@gmail.com', scopes: [GMAIL_SCOPES.read, GMAIL_SCOPES.labels] });
  assert.equal(sync.progress(account.id).status, 'syncing');
  assert.deepEqual(sync.permissions(account.id), ['read'], 'le jeton attend la fin de l’ancien import');
  const profilesBefore = g.requests.filter(r => r.path === 'profile').length;
  release();
  await Promise.all([oldSync, job]);
  assert.equal(g.requests.filter(r => r.path === 'profile').length, profilesBefore + 1, 'réimport demandé exécuté');
  assert.deepEqual(sync.permissions(account.id), ['read', 'labels']);
  assert.equal(store.getSync(account.id).window_days, 90);
  assert.equal(vault.open(account.id, store.getSecret(account.id)).refreshToken, 'new-rt');
  assert.equal(sync.progress(account.id).status, 'ok');
});

test('libellés importés : renommage externe sans renommer un dossier local partagé', async t => {
  const { store, sync, g, message, account } = await connected(t);
  g.labels.find(l => l.id === 'Label_7').name = 'Clients renommés';
  g.history = [{ labelsAdded: [{ message: { threadId: 't1' } }] }];
  await sync.syncNow(account.id);
  assert.equal(store.snapshot().folders.find(f => f.id === message.folderId).name, 'Clients renommés');
  const second = store.upsertAccount('perso', { name: 'Autre Gmail', channel: 'email', svc: 'gmail' });
  store.linkFolderLabel(message.folderId, second.id, 'Label_autre');
  store.ensureLabelFolder(second.id, 'Label_autre', 'Nom différent dans le second compte');
  assert.equal(store.snapshot().folders.find(f => f.id === message.folderId).name, 'Clients renommés');
});
