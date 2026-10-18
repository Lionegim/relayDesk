// Faux Google pour les lots B à D : jeton, révocation, lecture, brouillons et envoi. Aucun appel réseau réel.
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { seedIfEmpty } from '../../src/db/seed.js';
import { createStore } from '../../src/store.js';
import { createVault } from '../../src/secrets.js';
import { createGoogleOAuth } from '../../src/providers/gmail/oauth.js';
import { createGmailSync } from '../../src/providers/gmail/sync.js';

const b64 = s => Buffer.from(s, 'utf8').toString('base64url');

export const thread = (id, { labels = ['INBOX'], from = '"Claire Dubois" <claire@atlas.fr>', to = 'jh@gmail.com', cc = '', subject = 'Atelier', messageId = `<${id}@atlas.fr>`, references = '', text = 'Mardi 10h ?', date = Date.now() } = {}) => ({
  id,
  messages: [{
    id: `${id}-m`, threadId: id, labelIds: labels, snippet: text, internalDate: String(date),
    payload: {
      mimeType: 'text/plain',
      headers: [['From', from], ['To', to], ['Cc', cc], ['Subject', subject], ['Message-ID', messageId], ['References', references]]
        .filter(([, v]) => v).map(([name, value]) => ({ name, value })),
      body: { data: b64(text) },
    },
  }],
});

export function fakeGoogle({ threads = { t1: thread('t1') }, labels = [] } = {}) {
  const g = { threads, calls: [], drafts: {}, sent: [], revoked: [], seq: 0, fail: null };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  g.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    g.calls.push({ method, path: u.pathname, body });
    if (u.host === 'oauth2.googleapis.com') {
      if (u.pathname === '/revoke') { g.revoked.push(new URLSearchParams(String(init.body)).get('token')); return json({}); }
      return json({ access_token: 'at', expires_in: 3600 });
    }
    const path = u.pathname.replace('/gmail/v1/users/me/', '');
    if (g.fail?.(method, path)) return json({ error: { message: 'boom' } }, g.failStatus || 500);
    if (method === 'GET') {
      if (path === 'profile') return json({ emailAddress: 'jh@gmail.com', historyId: '10' });
      if (path === 'labels') return json({ labels });
      if (path === 'threads') return json({ threads: Object.keys(g.threads).map(id => ({ id })) });
      if (path.startsWith('threads/')) return g.threads[path.slice(8)] ? json(g.threads[path.slice(8)]) : json({}, 404);
      if (path === 'history') return json({ history: [], historyId: '10' });
    }
    if (method === 'POST' && path === 'drafts') {
      const id = `d${++g.seq}`;
      g.drafts[id] = body.message;
      return json({ id, message: { id: `dm${g.seq}`, threadId: body.message.threadId } });
    }
    if (method === 'PUT' && path.startsWith('drafts/')) {
      const id = path.slice(7);
      if (!g.drafts[id]) return json({}, 404);
      g.drafts[id] = body.message;
      return json({ id, message: { id: `dm-${id}`, threadId: body.message.threadId } });
    }
    if (method === 'DELETE' && path.startsWith('drafts/')) {
      const id = path.slice(7);
      if (!g.drafts[id]) return json({}, 404);
      delete g.drafts[id];
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === 'messages/send') { g.sent.push(body); return json({ id: 'sent1', threadId: body.threadId }); }
    if (method === 'POST' && path === 'drafts/send') {
      if (!g.drafts[body.id]) return json({}, 404);
      g.sent.push({ ...g.drafts[body.id], draftId: body.id });
      delete g.drafts[body.id];
      return json({ id: 'sent2' });
    }
    return json({ error: {} }, 404);
  };
  return g;
}

export function setup(opts) {
  const db = openDatabase(':memory:');
  seedIfEmpty(db);
  const store = createStore(db);
  const g = fakeGoogle(opts);
  const vault = createVault(randomBytes(32));
  const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'cs', fetchImpl: g.fetch });
  const sync = createGmailSync({ store, vault, oauth, fetchImpl: g.fetch, log: {} });
  return { db, store, g, vault, oauth, sync };
}

// Compte connecté et importé, avec les scopes indiqués dans le secret chiffré (format du lot A).
export async function connected(ctx, scopes = ['https://www.googleapis.com/auth/gmail.readonly']) {
  const { account, job } = ctx.sync.connect({ profileId: 'perso', name: 'Gmail JH', windowDays: 30, refreshToken: 'rt-secret', email: 'jh@gmail.com' });
  await job;
  ctx.store.putSecret(account.id, ctx.vault.seal(account.id, { refreshToken: 'rt-secret', email: 'jh@gmail.com', scopes }));
  return account;
}
