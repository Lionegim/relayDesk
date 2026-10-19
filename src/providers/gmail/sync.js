import {HttpError} from '../../http/errors.js';
import {credentialsMatch,changedClient,prepareMailConnection} from '../mail-credentials.js';
// Import initial et mise à jour incrémentale (history.list) des comptes Gmail, avec reprise après erreur.
import { createGmailClient } from './api.js';
import { threadToRecord } from './parse.js';
import { GMAIL_SCOPES, grantedPermissions } from './oauth.js';
import { createGmailActions } from './actions.js';

const MAX_THREADS = 1000;
const CONCURRENCY = 5;
const BASE_BACKOFF_MS = 60000;
const MAX_BACKOFF_MS = 30 * 60000;

async function pool(items, size, fn) {
  let i = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
}

export function createGmailSync({ store, vault, oauth, fetchImpl = globalThis.fetch, log = console, assertAccountAllowed=()=>{}, shouldPoll=()=>true }) {
  const clients = new Map();
  const running = new Map();
  const connecting = new Map();
  const failures = new Map(); // accountId -> { count, retryAt }
  const queues = new Map();
  const epochs = new Map(); // incrémenté par forget() : les tâches lancées avant n'écrivent plus rien
  const epoch = id => epochs.get(id) || 0;
  const gone = () => Object.assign(new Error('Compte déconnecté.'), { code: 'gone' });
  let timer = null;

  // Une synchronisation et une action du même compte ne peuvent pas s'écraser.
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
    assertAccountAllowed('gmail',store.getAccount(accountId).address);
    if (!clients.has(accountId)) {
      const cred = credentials(accountId);
      if (!cred) throw Object.assign(new Error('Aucun jeton pour ce compte.'), { code: 'invalid_grant' });
      if(!credentialsMatch(oauth,cred)) throw changedClient();
      const at = epoch(accountId);
      const live=()=>epoch(accountId)===at && store.hasAccount(accountId);
      const onRotate=refreshToken=>{
        if(!live()) throw new HttpError(409,'Compte déconnecté.','gone');
        const current=credentials(accountId);
        if(!credentialsMatch(oauth,current)) throw changedClient();
        store.putSecret(accountId,vault.seal(accountId,{...current,refreshToken,...(oauth.binding?{oauthBinding:oauth.binding}:{})}));
      };
      clients.set(accountId,{gmail:createGmailClient({refreshToken:cred.refreshToken,oauth,fetchImpl,onRotate}),email:cred.email,live});
    }
    return clients.get(accountId);
  }

  function permissions(accountId) {
    const cred = credentials(accountId);
    return credentialsMatch(oauth,cred) ? grantedPermissions(cred.scopes ?? [GMAIL_SCOPES.read]) : [];
  }
  const actions = createGmailActions({ store, client: id => client(id).gmail, permissions });

  async function labelNames(gmail) {
    const { labels = [] } = await gmail.labels();
    return Object.fromEntries(labels.filter(l => l.type === 'user').map(l => [l.id, l.name]));
  }

  async function applyThread(accountId, { gmail, email, live }, names, threadId) {
    let thread;
    try {
      thread = await gmail.getThread(threadId);
    } catch (e) {
      if (e.code !== 'not_found') throw e;
    }
    if (!live()) throw gone();
    if (!thread) return store.removeThread(accountId, threadId);
    const currentFolder = store.getThreadFolder(accountId, threadId);
    const preferredLabelId = currentFolder && store.folderLabel(currentFolder, accountId);
    const rec = threadToRecord(thread, { ownEmail: email, labelNames: names, preferredLabelId });
    if (!rec) return store.removeThread(accountId, threadId);
    rec.folderId = rec.labelId ? store.ensureLabelFolder(accountId, rec.labelId, names[rec.labelId]) : null;
    store.upsertThread(accountId, rec, { syncFolder: permissions(accountId).includes('labels') });
  }

  async function initialSync(accountId) {
    const c = client(accountId), { gmail } = c;
    const days = store.getSync(accountId)?.window_days || 30;
    store.setSync(accountId, { status: 'syncing', total: 0, done: 0, error: null });
    // historyId relevé avant la liste : aucun changement ne passe entre les deux.
    const profile = await gmail.profile();
    const names = await labelNames(gmail);
    const ids = [];
    let pageToken;
    do {
      const page = await gmail.listThreads(`newer_than:${days}d`, pageToken);
      ids.push(...(page.threads || []).map(t => t.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_THREADS);
    const todo = ids.slice(0, MAX_THREADS);
    store.setSync(accountId, { total: todo.length });
    let done = 0;
    await pool(todo, CONCURRENCY, async id => {
      await applyThread(accountId, c, names, id);
      done++;
      if (done % 5 === 0 || done === todo.length) store.setSync(accountId, { done });
    });
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: profile.historyId, done: todo.length, last_sync_at: new Date().toISOString() });
    store.setAccountStatus(accountId, 'Connecté', 'ok');
  }

  async function incrementalSync(accountId) {
    const state = store.getSync(accountId);
    if (!state?.history_id) return initialSync(accountId);
    const c = client(accountId), { gmail } = c;
    const changed = new Set();
    let historyId = state.history_id, pageToken;
    try {
      do {
        const page = await gmail.history(state.history_id, pageToken);
        for (const h of page.history || []) {
          const messages = [...(h.messages || []), ...['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']
            .flatMap(k => (h[k] || []).map(entry => entry.message))];
          for (const m of messages) if (m?.threadId) changed.add(m.threadId);
        }
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // historyId trop ancien : Google ne garde qu'un historique limité, on réimporte.
      if (e.code === 'not_found') return initialSync(accountId);
      throw e;
    }
    if (changed.size) {
      const names = await labelNames(gmail);
      await pool([...changed], CONCURRENCY, id => applyThread(accountId, c, names, id));
    }
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: historyId, error: null, last_sync_at: new Date().toISOString() });
    if (store.getAccount(accountId).c !== 'ok') store.setAccountStatus(accountId, 'Connecté', 'ok');
  }

  async function run(accountId, fn, { force = false } = {}) {
    if (running.has(accountId) && !force) return;
    running.set(accountId, (running.get(accountId) || 0) + 1);
    try {
      await serial(accountId, () => fn(accountId));
      failures.delete(accountId);
      return true;
    } catch (e) {
      if (e.code === 'gone' || !store.hasAccount(accountId)) return;
      const count = (failures.get(accountId)?.count || 0) + 1;
      failures.set(accountId, { count, retryAt: Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1)) });
      if (e.code === 'invalid_grant' || e.code==='oauth_client_changed') {
        clients.delete(accountId);
        store.setAccountStatus(accountId, 'À reconnecter', 'warn');
        store.setSync(accountId, { status: 'error', error: 'Accès révoqué ou expiré : reconnecte le compte.' });
      } else {
        store.setSync(accountId, { status: 'error', error: e.message });
        if (e.code !== 'retryable') store.setAccountStatus(accountId, 'Erreur de synchronisation', 'warn');
      }
      log.error?.(`Synchronisation Gmail du compte ${accountId} : ${e.message}`);
      return false;
    } finally {
      const remaining = running.get(accountId) - 1;
      if (remaining) running.set(accountId, remaining); else running.delete(accountId);
    }
  }

  function tick() {
    const now = Date.now();
    for (const id of store.accountsBySvc('gmail')) {
      const s = store.getSync(id);
      if (!s || !store.getSecret(id) || running.has(id)) continue;
      if ((failures.get(id)?.retryAt || 0) > now) continue;
      if (store.getAccount(id).status === 'À reconnecter') continue;
      if (!shouldPoll(id)) continue;
      run(id, s.status === 'syncing' || !s.history_id ? initialSync : incrementalSync);
    }
  }

  return {
    // Enregistre le compte après l'autorisation et lance l'import en arrière-plan.
    connect({profileId,name,windowDays,refreshToken,email,scopes=[GMAIL_SCOPES.read],expectedAccount=null,expectNew=false,authorize=()=>{}}) {
      const prepared=prepareMailConnection({store,oauth,service:'gmail',profileId,name,email,expectedAccount,expectNew,authorize,assertAccountAllowed,generation:epoch});
      const {account}=prepared;email=prepared.email;
      let accept,reject;const ready=new Promise((resolve,no)=>{accept=resolve;reject=no;});ready.catch(()=>{});
      const pending={started:false};connecting.set(account.id,pending);
      const job=run(account.id,async()=>{
        pending.started=true;
        try {
          prepared.guard();
          store.transaction(()=>{
            store.putSecret(account.id,vault.seal(account.id,{refreshToken,email,scopes,...(oauth.binding?{oauthBinding:oauth.binding}:{})}));
            store.setAccountStatus(account.id,'Synchronisation…','info');
            store.setSync(account.id,{status:'syncing',window_days:windowDays,history_id:null,total:0,done:0,error:null});
          });
          epochs.set(account.id,epoch(account.id)+1);clients.delete(account.id);failures.delete(account.id);
          accept();
        } catch(error) {reject(error);throw gone();}
        await initialSync(account.id);
      },{force:true});
      job.then(()=>{if(connecting.get(account.id)===pending)connecting.delete(account.id);});
      return {account:store.getAccount(account.id),job,ready};
    },
    progress(accountId) {
      const s = store.getSync(accountId);
      if (connecting.has(accountId) && !connecting.get(accountId).started) return { status: 'syncing', total: 0, done: 0, error: null, ...store.countThreads(accountId) };
      if (!s) return null;
      return { status: s.status, total: s.total, done: s.done, error: s.error, ...store.countThreads(accountId) };
    },
    syncNow: accountId => run(accountId, incrementalSync),
    notify: accountId => run(accountId, id => store.getSync(id)?.history_id ? incrementalSync(id) : initialSync(id), {force:true}),
    permissions,
    // Lots C et D : écritures (brouillons, envoi) dans la file du compte, avec son client Gmail.
    exclusive: (accountId, fn) => serial(accountId, () => fn(client(accountId))),
    // Génération du compte : change à chaque forget() (déconnexion), même si l'identifiant est réutilisé ensuite.
    generation: accountId => epoch(accountId),
    // Même file, sans client Gmail (enregistrement local d'un compte sans permission ou non connecté).
    queue: (accountId, fn) => serial(accountId, fn),
    // Lot B : coupe immédiatement les tâches en cours (elles n'écrivent plus rien), puis exécute `fn`
    // dans la file du compte, après la fin de la tâche en cours.
    forget(accountId, fn) {
      epochs.set(accountId, epoch(accountId) + 1);
      clients.delete(accountId);
      failures.delete(accountId);
      connecting.delete(accountId);
      return serial(accountId, fn);
    },
    updateMessage(id, patch) {
      const { accountId } = store.getMessageSource(id);
      return serial(accountId, () => actions.updateMessage(id, patch));
    },
    start(intervalMs = 60000) {
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    pause() { clearInterval(timer); },
    async drain() {
      while(queues.size || running.size || connecting.size) {
        await Promise.allSettled([...queues.values()]);
        await new Promise(resolve=>setImmediate(resolve));
      }
    },
    stop() { clearInterval(timer); },
  };
}
