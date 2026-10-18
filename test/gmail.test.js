import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/secrets.js';
import { createGoogleOAuth } from '../src/providers/gmail/oauth.js';
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
  const g = { threads: { t1: THREAD }, history: [], historyId: '100', historyGone: false, tokenCalls: [] };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.host === 'oauth2.googleapis.com') {
      const p = new URLSearchParams(String(init.body));
      g.tokenCalls.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        const idToken = `x.${b64(JSON.stringify({ email: 'jh@gmail.com' }))}.y`;
        return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt-secret', scope: 'openid https://www.googleapis.com/auth/gmail.readonly', id_token: idToken });
      }
      return json({ access_token: 'at2', expires_in: 3600 });
    }
    assert.equal(init.headers.authorization.startsWith('Bearer '), true);
    const path = u.pathname.replace('/gmail/v1/users/me/', '');
    if (path === 'profile') return json({ emailAddress: 'jh@gmail.com', historyId: g.historyId });
    if (path === 'labels') return json({ labels: [{ id: 'Label_7', name: 'Clients', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }] });
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
  const sync = createGmailSync({ store, vault: createVault(randomBytes(32)), oauth, fetchImpl: g.fetch, log: {} });
  return { db, store, g, oauth, sync };
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
