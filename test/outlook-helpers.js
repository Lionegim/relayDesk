// Faux Microsoft (identité + Graph courrier) en mémoire : jetons avec rotation, dossiers, delta par dossier,
// déplacements, brouillons MIME et envoi MIME. Aucun appel réseau réel.
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/secrets.js';
import { createMicrosoftOAuth } from '../src/providers/outlook/oauth.js';
import { createOutlookSync } from '../src/providers/outlook/sync.js';

export const G = 'https://graph.microsoft.com/';
export const ALL_SCOPES = ['openid', 'email', 'offline_access', `${G}User.Read`, `${G}Mail.ReadWrite`, `${G}Mail.Send`].join(' ');

export function fakeMicrosoft({ scope = `openid email offline_access ${G}User.Read ${G}Mail.Read`, me = { mail: 'jh@outlook.fr', userPrincipalName: 'jh@outlook.fr' } } = {}) {
  const now = Date.now();
  const m = {
    calls: [], tokenCalls: [], sent: [], scope, me, seq: 0, ids: 0, rt: 0, expireDelta: false, fail: null, failStatus: 500,
    folders: [
      { id: 'F-inbox', displayName: 'Boîte de réception', parentFolderId: 'root', wk: 'inbox' },
      { id: 'F-archive', displayName: 'Archive', parentFolderId: 'root', wk: 'archive' },
      { id: 'F-sent', displayName: 'Éléments envoyés', parentFolderId: 'root', wk: 'sentitems' },
      { id: 'F-deleted', displayName: 'Éléments supprimés', parentFolderId: 'root', wk: 'deleteditems' },
      { id: 'F-junk', displayName: 'Courrier indésirable', parentFolderId: 'root', wk: 'junkemail' },
      { id: 'F-drafts', displayName: 'Brouillons', parentFolderId: 'root', wk: 'drafts' },
      { id: 'F-clients', displayName: 'Clients', parentFolderId: 'root' },
    ],
    messages: [],
    events: [], // { seq, folderId, id, conversationId, removed }
  };
  const ev = (folderId, msg, removed = false) => m.events.push({ seq: ++m.seq, folderId, id: msg.id, conversationId: msg.conversationId, removed });
  m.add = (fields) => {
    const msg = {
      id: `M${++m.ids}`, conversationId: 'C1', parentFolderId: 'F-inbox', subject: 'Atelier', body: 'Mardi 10h ?', isRead: false, isDraft: false,
      flag: { flagStatus: 'notFlagged' }, importance: 'normal', inferenceClassification: 'focused', receivedDateTime: new Date(now - 3600000).toISOString(),
      from: { emailAddress: { name: 'Claire Dubois', address: 'claire@atlas.fr' } }, toRecipients: [{ emailAddress: { name: 'JH', address: 'jh@outlook.fr' } }],
      ccRecipients: [], replyTo: [], internetMessageId: `<m${m.ids}@atlas.fr>`, headers: [], ...fields,
    };
    m.messages.push(msg);
    ev(msg.parentFolderId, msg);
    return msg;
  };
  m.moveTo = (msg, folderId) => {
    ev(msg.parentFolderId, msg, true);
    msg.id = `M${++m.ids}`; // un déplacement change l'identifiant, comme dans Exchange
    msg.parentFolderId = folderId;
    ev(folderId, msg);
    return msg;
  };
  m.change = (msg, fields) => { Object.assign(msg, fields); ev(msg.parentFolderId, msg); };
  // Suppression définitive : seul l'identifiant apparaît dans le delta (@removed).
  m.hardDelete = msg => { m.messages.splice(m.messages.indexOf(msg), 1); ev(msg.parentFolderId, msg, true); };
  const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
  const view = x => ({
    id: x.id, conversationId: x.conversationId, parentFolderId: x.parentFolderId, subject: x.subject, bodyPreview: String(x.body).slice(0, 80),
    body: { contentType: 'text', content: x.body }, from: x.from, toRecipients: x.toRecipients, ccRecipients: x.ccRecipients, replyTo: x.replyTo,
    receivedDateTime: x.receivedDateTime, isRead: x.isRead, isDraft: x.isDraft, flag: x.flag, importance: x.importance,
    inferenceClassification: x.inferenceClassification, internetMessageId: x.internetMessageId, internetMessageHeaders: x.headers,
  });
  const folderOf = key => m.folders.find(f => f.id === key || f.wk === key);

  m.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    if (u.host === 'login.microsoftonline.com') {
      const p = new URLSearchParams(String(init.body));
      m.tokenCalls.push(Object.fromEntries(p));
      if (p.get('client_secret')) return json({ error: 'invalid_client' }, 400);
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'revoked') return json({ error: 'invalid_grant' }, 400);
      const idToken = `x.${Buffer.from(JSON.stringify({ preferred_username: m.idUser || m.me.mail })).toString('base64url')}.y`;
      // Rotation : chaque rafraîchissement renvoie un nouveau jeton.
      return json({ access_token: `at${m.rt}`, expires_in: 3600, refresh_token: `rt-rot-${++m.rt}`, scope: m.scope, id_token: idToken });
    }
    if (u.host !== 'graph.microsoft.com') throw new Error('hôte inattendu ' + u.host);
    if (!String(init.headers?.authorization || '').startsWith('Bearer at')) return json({}, 401);
    const path = u.pathname.replace('/v1.0/', '');
    const raw = init.body && init.headers['content-type'] === 'text/plain' ? Buffer.from(init.body, 'base64').toString('utf8') : null;
    const body = init.body && init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : null;
    m.calls.push({ method, path, search: u.search, body, raw });
    if (m.fail?.(method, path)) return json({ error: { message: 'contenu secret' } }, m.failStatus);
    let r;
    if (method === 'GET' && path === 'me') return json(m.me);
    if (method === 'GET' && path === 'me/mailFolders') {
      // Pagination réelle : m.pageSize éléments par page, suite via @odata.nextLink.
      const list = m.folders.filter(f => f.parentFolderId === 'root').map(f => ({ ...f, childFolderCount: m.folders.filter(c => c.parentFolderId === f.id).length }));
      const skip = Number(u.searchParams.get('$skip') || 0), size = m.pageSize || 100;
      const next = skip + size < list.length ? `https://graph.microsoft.com/v1.0/me/mailFolders?$skip=${skip + size}` : undefined;
      return json({ value: list.slice(skip, skip + size), ...(next ? { '@odata.nextLink': next } : {}) });
    }
    if ((r = path.match(/^me\/mailFolders\/([^/]+)\/childFolders$/))) {
      const parent = folderOf(decodeURIComponent(r[1]));
      if (method === 'POST') {
        if (m.folders.some(f => f.parentFolderId === parent.id && f.displayName === body.displayName)) return json({ error: {} }, 409);
        const f = { id: `F${++m.ids}`, displayName: body.displayName, parentFolderId: parent.id };
        m.folders.push(f); return json(f, 201);
      }
      return json({ value: m.folders.filter(f => f.parentFolderId === parent.id).map(f => ({ ...f, childFolderCount: m.folders.filter(c => c.parentFolderId === f.id).length })) });
    }
    if (method === 'POST' && path === 'me/mailFolders') {
      if (m.folders.some(f => f.parentFolderId === 'root' && f.displayName === body.displayName)) return json({ error: {} }, 409);
      const f = { id: `F${++m.ids}`, displayName: body.displayName, parentFolderId: 'root' };
      m.folders.push(f); return json(f, 201);
    }
    if ((r = path.match(/^me\/mailFolders\/([^/]+)\/messages\/delta$/))) {
      const f = folderOf(decodeURIComponent(r[1]));
      if (!f) return json({}, 404);
      const token = u.searchParams.get('$deltatoken');
      const link = `https://graph.microsoft.com/v1.0/me/mailFolders/${f.id}/messages/delta?$deltatoken=${m.seq}`;
      if (token === null) {
        const since = (u.searchParams.get('$filter') || '').match(/receivedDateTime ge (\S+)/)?.[1];
        const value = m.messages.filter(x => x.parentFolderId === f.id && (!since || x.receivedDateTime >= since)).map(x => ({ id: x.id, conversationId: x.conversationId }));
        return json({ value, '@odata.deltaLink': link });
      }
      if (m.expireDelta) return json({ error: { code: 'SyncStateNotFound' } }, 410);
      const value = m.events.filter(e => e.seq > Number(token) && e.folderId === f.id)
        .map(e => (e.removed ? { id: e.id, '@removed': { reason: 'deleted' } } : { id: e.id, conversationId: e.conversationId }));
      return json({ value, '@odata.deltaLink': link });
    }
    if ((r = path.match(/^me\/mailFolders\/([^/]+)$/))) {
      const f = folderOf(decodeURIComponent(r[1]));
      return f ? json({ id: f.id, displayName: f.displayName }) : json({}, 404);
    }
    if (method === 'GET' && path === 'me/messages') {
      const conv = (u.searchParams.get('$filter') || '').match(/conversationId eq '(.*)'$/)?.[1]?.replace(/''/g, "'");
      return json({ value: m.messages.filter(x => x.conversationId === conv).map(view) });
    }
    if (method === 'POST' && path === 'me/messages' && raw) {
      const d = { id: `D${++m.ids}`, conversationId: 'CD', parentFolderId: 'F-drafts', isDraft: true, mime: raw, fields: null };
      m.messages.push(d); return json({ id: d.id, isDraft: true }, 201);
    }
    if ((r = path.match(/^me\/messages\/([^/]+)\/move$/))) {
      const x = m.messages.find(y => y.id === decodeURIComponent(r[1]));
      if (!x) return json({}, 404);
      return json(view(m.moveTo(x, folderOf(body.destinationId).id)), 201);
    }
    if ((r = path.match(/^me\/messages\/([^/]+)$/)) && method === 'PATCH') {
      const x = m.messages.find(y => y.id === decodeURIComponent(r[1]));
      if (!x) return json({}, 404);
      if (x.isDraft) { x.fields = body; return json({ id: x.id }); }
      m.change(x, body);
      return json(view(x));
    }
    if (method === 'POST' && path === 'me/sendMail') { m.sent.push(raw); return json(null, 202); }
    return json({ error: {} }, 404);
  };
  return m;
}

export function setupOutlook(opts) {
  const db = openDatabase(':memory:');
  seedIfEmpty(db);
  const store = createStore(db);
  const ms = fakeMicrosoft(opts);
  const vault = createVault(randomBytes(32));
  const oauth = createMicrosoftOAuth({ clientId: 'client-id', fetchImpl: ms.fetch });
  const sync = createOutlookSync({ store, vault, oauth, fetchImpl: ms.fetch, log: {} });
  return { db, store, ms, vault, oauth, sync };
}

export async function connectedOutlook(ctx, scopes = [`${G}Mail.Read`]) {
  const { account, job } = ctx.sync.connect({ profileId: 'perso', name: 'Outlook JH', windowDays: 30, refreshToken: 'rt-initial', email: 'jh@outlook.fr', scopes });
  await job;
  return account;
}

