// Import et synchronisation incrémentale (delta Graph par dossier) des comptes Outlook / Microsoft 365.
// Même contrat que la synchronisation Gmail : file par compte, génération, reprise après erreur.
import { createGraphClient } from './api.js';
import { conversationToRecord } from './parse.js';
import { OUTLOOK_SCOPES, grantedPermissions } from './oauth.js';
import { createOutlookActions } from './actions.js';

const MAX_THREADS = 1000;
const CONCURRENCY = 4;
const BASE_BACKOFF_MS = 60000;
const MAX_BACKOFF_MS = 30 * 60000;
const MAX_FOLDER_DEPTH = 4;
// Dossiers système : inbox et archive comptent pour l'archivage ; les autres ne sont jamais des dossiers Relay.
const WELL_KNOWN = ['inbox', 'archive', 'sentitems', 'deleteditems', 'junkemail', 'drafts', 'outbox'];
const SKIPPED = ['deleteditems', 'junkemail', 'drafts', 'outbox'];

async function pool(items, size, fn) {
  let i = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// Curseurs delta par dossier, conservés en JSON dans sync_state.history_id (aucune colonne dédiée nécessaire).
const readCursor = raw => { try { const c = JSON.parse(raw); return c && c.v === 1 && c.links ? c : null; } catch { return null; } };
const writeCursor = links => JSON.stringify({ v: 1, links });

export function createOutlookSync({ store, vault, oauth, fetchImpl = globalThis.fetch, log = console }) {
  const clients = new Map();
  const running = new Map();
  const connecting = new Map();
  const failures = new Map();
  const queues = new Map();
  const epochs = new Map();
  const epoch = id => epochs.get(id) || 0;
  const gone = () => Object.assign(new Error('Compte déconnecté.'), { code: 'gone' });
  let timer = null;

  function serial(accountId, fn) {
    const job = (queues.get(accountId) || Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    queues.set(accountId, tail);
    tail.then(() => { if (queues.get(accountId) === tail) queues.delete(accountId); });
    return job;
  }

  function credentials(accountId) {
    const sealed = store.getSecret(accountId);
    return sealed ? vault.open(accountId, sealed) : null;
  }
  function client(accountId) {
    if (!clients.has(accountId)) {
      const cred = credentials(accountId);
      if (!cred) throw Object.assign(new Error('Aucun jeton pour ce compte.'), { code: 'invalid_grant' });
      const at = epoch(accountId);
      const live = () => epoch(accountId) === at && store.hasAccount(accountId);
      // Microsoft renouvelle le jeton de rafraîchissement : le nouveau est rechiffré, jamais journalisé.
      const onRotate = refreshToken => {
        if (!live()) return;
        const cur = credentials(accountId) || cred;
        store.putSecret(accountId, vault.seal(accountId, { ...cur, refreshToken }));
      };
      clients.set(accountId, { graph: createGraphClient({ refreshToken: cred.refreshToken, oauth, fetchImpl, onRotate }), email: cred.email, live });
    }
    return clients.get(accountId);
  }

  function permissions(accountId) {
    const cred = credentials(accountId);
    return cred ? grantedPermissions(cred.scopes ?? [OUTLOOK_SCOPES.read]) : [];
  }

  // Dossiers du compte : identifiants système et dossiers personnels (chemins « Parent/Enfant »).
  async function folderMap(graph) {
    const known = {};
    for (const name of WELL_KNOWN) {
      try { known[name] = (await graph.wellKnown(name)).id; } catch (e) { if (e.code !== 'not_found') throw e; }
    }
    const systemIds = new Set(Object.values(known));
    const user = {};
    const walk = async (list, prefix, depth) => {
      for (const f of list) {
        if (systemIds.has(f.id)) continue;
        const path = prefix ? `${prefix}/${f.displayName}` : f.displayName;
        user[f.id] = path;
        if (depth < MAX_FOLDER_DEPTH && f.childFolderCount) await walk((await graph.childFolders(f.id)).value || [], path, depth + 1);
      }
    };
    await walk((await graph.folders()).value || [], '', 1);
    return {
      inbox: known.inbox, archive: known.archive, known, user,
      skip: new Set(SKIPPED.map(n => known[n]).filter(Boolean)),
      // Suivis par delta : tout sauf brouillons et boîte d'envoi (corbeille et indésirables pour voir les suppressions).
      tracked: [...new Set([known.inbox, known.archive, known.sentitems, known.deleteditems, known.junkemail, ...Object.keys(user)].filter(Boolean))],
    };
  }

  async function applyConversation(accountId, c, folders, conversationId) {
    const messages = await c.graph.conversation(conversationId);
    if (!c.live()) throw gone();
    const currentFolder = store.getThreadFolder(accountId, conversationId);
    const preferredLabelId = currentFolder && store.folderLabel(currentFolder, accountId);
    const rec = conversationToRecord(conversationId, messages, { ownEmail: c.email, folders, preferredLabelId });
    if (!rec) return store.removeThread(accountId, conversationId);
    rec.folderId = rec.labelId ? store.ensureLabelFolder(accountId, rec.labelId, folders.user[rec.labelId]) : null;
    store.upsertThread(accountId, rec, { syncFolder: permissions(accountId).includes('labels') });
  }

  // Parcourt un delta jusqu'au deltaLink ; renvoie les conversations touchées et le nouveau lien.
  async function drain(graph, folderId, link, sinceIso, changed) {
    let next = link, deltaLink = null;
    do {
      const page = await graph.delta(folderId, next, next ? null : sinceIso);
      for (const m of page.value || []) if (m.conversationId) changed.add(m.conversationId);
      next = page['@odata.nextLink'] || null;
      deltaLink = page['@odata.deltaLink'] || deltaLink;
    } while (next);
    return deltaLink;
  }

  async function initialSync(accountId) {
    const c = client(accountId);
    const days = store.getSync(accountId)?.window_days || 30;
    store.setSync(accountId, { status: 'syncing', total: 0, done: 0, error: null });
    if (!c.email) {
      const me = await c.graph.me();
      c.email = String(me.mail || me.userPrincipalName || '').toLowerCase() || null;
    }
    const folders = await folderMap(c.graph);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    // Curseurs pris avant l'import : un changement pendant l'import sera revu au passage suivant.
    const changed = new Set(), links = {};
    for (const id of folders.tracked) links[id] = await drain(c.graph, id, null, since, changed);
    const todo = [...changed].slice(0, MAX_THREADS);
    if (!c.live()) throw gone();
    store.setSync(accountId, { total: todo.length });
    let done = 0;
    await pool(todo, CONCURRENCY, async id => {
      await applyConversation(accountId, c, folders, id);
      done++;
      if (done % 5 === 0 || done === todo.length) store.setSync(accountId, { done });
    });
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: writeCursor(links), done: todo.length, last_sync_at: new Date().toISOString() });
    store.setAccountStatus(accountId, 'Connecté', 'ok');
  }

  async function incrementalSync(accountId) {
    const state = store.getSync(accountId);
    const cursor = readCursor(state?.history_id);
    if (!cursor) return initialSync(accountId);
    const c = client(accountId);
    const folders = await folderMap(c.graph);
    const since = new Date(Date.now() - (state.window_days || 30) * 86400000).toISOString();
    const changed = new Set(), links = {};
    try {
      for (const id of folders.tracked) links[id] = await drain(c.graph, id, cursor.links[id] || null, since, changed);
    } catch (e) {
      // Curseur expiré ou dossier disparu : réimport complet de la fenêtre.
      if (e.code === 'gone_cursor' || e.code === 'not_found') return initialSync(accountId);
      throw e;
    }
    if (changed.size) await pool([...changed], CONCURRENCY, id => applyConversation(accountId, c, folders, id));
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: writeCursor(links), error: null, last_sync_at: new Date().toISOString() });
    if (store.getAccount(accountId).c !== 'ok') store.setAccountStatus(accountId, 'Connecté', 'ok');
  }

  async function run(accountId, fn, { force = false } = {}) {
    if (running.has(accountId) && !force) return;
    running.set(accountId, (running.get(accountId) || 0) + 1);
    try {
      await serial(accountId, () => fn(accountId));
      failures.delete(accountId);
    } catch (e) {
      if (e.code === 'gone' || !store.hasAccount(accountId)) return;
      const count = (failures.get(accountId)?.count || 0) + 1;
      failures.set(accountId, { count, retryAt: Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1)) });
      if (e.code === 'invalid_grant') {
        clients.delete(accountId);
        store.setAccountStatus(accountId, 'À reconnecter', 'warn');
        store.setSync(accountId, { status: 'error', error: 'Accès révoqué ou expiré : reconnecte le compte.' });
      } else {
        store.setSync(accountId, { status: 'error', error: e.message });
        if (e.code !== 'retryable') store.setAccountStatus(accountId, 'Erreur de synchronisation', 'warn');
      }
      log.error?.(`Synchronisation Outlook du compte ${accountId} : ${e.message}`);
    } finally {
      const remaining = running.get(accountId) - 1;
      if (remaining) running.set(accountId, remaining); else running.delete(accountId);
    }
  }

  function tick() {
    const now = Date.now();
    for (const id of store.accountsBySvc('outlook')) {
      const s = store.getSync(id);
      if (!s || !store.getSecret(id) || running.has(id)) continue;
      if ((failures.get(id)?.retryAt || 0) > now) continue;
      if (store.getAccount(id).status === 'À reconnecter') continue;
      run(id, s.status === 'syncing' || !readCursor(s.history_id) ? initialSync : incrementalSync);
    }
  }

  const actions = createOutlookActions({ store, client: id => client(id).graph, permissions });

  return {
    connect({ profileId, name, windowDays, refreshToken, email, scopes = [OUTLOOK_SCOPES.read] }) {
      const account = store.upsertAccount(profileId, { name, channel: 'email', svc: 'outlook', address: email || null });
      const pending = { started: false };
      connecting.set(account.id, pending);
      const job = run(account.id, async () => {
        pending.started = true;
        store.putSecret(account.id, vault.seal(account.id, { refreshToken, email: email || null, scopes }));
        clients.delete(account.id);
        failures.delete(account.id);
        store.setAccountStatus(account.id, 'Synchronisation…', 'info');
        store.setSync(account.id, { status: 'syncing', window_days: windowDays, history_id: null, total: 0, done: 0, error: null });
        await initialSync(account.id);
        // Adresse lue sur /me si l'autorisation ne l'a pas fournie.
        const c = clients.get(account.id);
        if (!email && c?.email && c.live()) {
          store.upsertAccount(profileId, { name, channel: 'email', svc: 'outlook', address: c.email });
          store.putSecret(account.id, vault.seal(account.id, { ...credentials(account.id), email: c.email }));
        }
      }, { force: true });
      job.then(() => { if (connecting.get(account.id) === pending) connecting.delete(account.id); });
      return { account: store.getAccount(account.id), job };
    },
    progress(accountId) {
      const s = store.getSync(accountId);
      if (connecting.has(accountId) && !connecting.get(accountId).started) return { status: 'syncing', total: 0, done: 0, error: null, ...store.countThreads(accountId) };
      if (!s) return null;
      return { status: s.status, total: s.total, done: s.done, error: s.error, ...store.countThreads(accountId) };
    },
    syncNow: accountId => run(accountId, incrementalSync),
    permissions,
    updateMessage(id, patch) {
      const { accountId } = store.getMessageSource(id);
      return serial(accountId, () => actions.updateMessage(id, patch));
    },
    generation: accountId => epoch(accountId),
    forget(accountId, fn) {
      epochs.set(accountId, epoch(accountId) + 1);
      clients.delete(accountId);
      failures.delete(accountId);
      connecting.delete(accountId);
      return serial(accountId, fn);
    },
    exclusive: (accountId, fn) => serial(accountId, () => fn(client(accountId))),
    queue: (accountId, fn) => serial(accountId, fn),
    start(intervalMs = 60000) {
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
}
