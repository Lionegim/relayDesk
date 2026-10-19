import {HttpError} from '../../http/errors.js';
import {credentialsMatch,changedClient,prepareMailConnection} from '../mail-credentials.js';
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
const MAX_FOLDER_DEPTH = Infinity;
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

// Curseurs delta par dossier et correspondance message → conversation, conservés en JSON dans sync_state.history_id
// (aucune colonne dédiée). La correspondance permet d'appliquer les suppressions : une entrée @removed du delta ne
// porte en général que l'identifiant du message.
const readCursor = raw => { try { const c = JSON.parse(raw); return c && c.v === 1 && c.links ? c : null; } catch { return null; } };
const writeCursor = (links, ids) => JSON.stringify({ v: 1, links, ids: Object.fromEntries(ids) });

export function createOutlookSync({ store, vault, oauth, fetchImpl = globalThis.fetch, log = console, assertAccountAllowed=()=>{}, shouldPoll=()=>true }) {
  const clients = new Map();
  const archiveMetadata = new Map();
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
    assertAccountAllowed('outlook',store.getAccount(accountId).address);
    if (!clients.has(accountId)) {
      const cred = credentials(accountId);
      if (!cred) throw Object.assign(new Error('Aucun jeton pour ce compte.'), { code: 'invalid_grant' });
      if(!credentialsMatch(oauth,cred)) throw changedClient();
      const at = epoch(accountId);
      const live = () => epoch(accountId) === at && store.hasAccount(accountId);
      // Microsoft renouvelle le jeton de rafraîchissement : le nouveau est rechiffré, jamais journalisé.
      const onRotate = refreshToken => {
        if (!live()) throw new HttpError(409,'Compte déconnecté.','gone');
        const cur = credentials(accountId);
        if(!credentialsMatch(oauth,cur)) throw changedClient();
        store.putSecret(accountId, vault.seal(accountId, { ...cur, refreshToken, ...(oauth.binding?{oauthBinding:oauth.binding}:{}) }));
      };
      clients.set(accountId, { graph: createGraphClient({ refreshToken: cred.refreshToken, oauth, fetchImpl, onRotate }), email: cred.email, live });
    }
    return clients.get(accountId);
  }

  function permissions(accountId) {
    const cred = credentials(accountId);
    return credentialsMatch(oauth,cred) ? grantedPermissions(cred.scopes ?? [OUTLOOK_SCOPES.read]) : [];
  }

  // Dossiers du compte : identifiants système et dossiers personnels (chemins « Parent/Enfant »).
  async function folderMap(graph,depthLimit=MAX_FOLDER_DEPTH) {
    const visited=new Set();
    const known = {};
    for (const name of WELL_KNOWN) {
      try { known[name] = (await graph.wellKnown(name)).id; } catch (e) { if (e.code !== 'not_found') throw e; }
    }
    const systemIds = new Set(Object.values(known));
    const user = {};
    // Les dossiers système ne sont jamais des dossiers Relay, mais leurs sous-dossiers personnels le sont
    // (ex. « Boîte de réception/Projet »), sauf sous les dossiers ignorés (corbeille, indésirables…).
    const skippedIds = new Set(SKIPPED.map(n => known[n]).filter(Boolean));
    const walk = async (list, prefix, depth) => {
      for (const f of list) {
        if(visited.has(f.id))continue;visited.add(f.id);
        if(visited.size>10000)throw new HttpError(409,'Trop de dossiers Outlook pour cet import.','folder_limit');
        if (skippedIds.has(f.id)) continue;
        const path = prefix ? `${prefix}/${f.displayName}` : f.displayName;
        if (!systemIds.has(f.id)) user[f.id] = path;
        if (depth < depthLimit && f.childFolderCount) await walk((await graph.childFolders(f.id)).value || [], path, depth + 1);
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

  async function applyConversation(accountId, c, folders, conversationId, ids) {
    const messages = await c.graph.conversation(conversationId);
    if (!c.live()) throw gone();
    for (const [id, conv] of ids) if (conv === conversationId) ids.delete(id);
    for (const m of messages) if (m.id) ids.set(m.id, conversationId);
    const currentFolder = store.getThreadFolder(accountId, conversationId);
    const preferredLabelId = currentFolder && store.folderLabel(currentFolder, accountId);
    const rec = conversationToRecord(conversationId, messages, { ownEmail: c.email, folders, preferredLabelId });
    if (!rec) return store.removeThread(accountId, conversationId);
    rec.folderId = rec.labelId ? store.ensureLabelFolder(accountId, rec.labelId, folders.user[rec.labelId]) : null;
    store.upsertThread(accountId, rec, { syncFolder: permissions(accountId).includes('labels') });
  }

  // Parcourt un delta jusqu'au deltaLink ; renvoie les conversations touchées et le nouveau lien.
  // Une entrée supprimée sans conversationId est rattachée par la correspondance des identifiants déjà importés.
  async function drain(graph, folderId, link, sinceIso, changed, ids) {
    let next = link, deltaLink = null;
    do {
      const page = await graph.delta(folderId, next, next ? null : sinceIso);
      for (const m of page.value || []) {
        const conv = m.conversationId || ids.get(m.id);
        if (conv) changed.add(conv);
      }
      next = page['@odata.nextLink'] || null;
      deltaLink = page['@odata.deltaLink'] || deltaLink;
    } while (next);
    return deltaLink;
  }

  async function initialSync(accountId) {
    // An expired live cursor must also reconcile the archive already authorized.
    // Recent arrivals resume first; the durable worker repairs older state.
    if(store.history?.get(accountId))store.history.restart(store.history.get(accountId));
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
    const changed = new Set(), links = {}, ids = new Map();
    for (const id of folders.tracked) links[id] = await drain(c.graph, id, null, since, changed, ids);
    const todo = [...changed].slice(0, MAX_THREADS);
    if (!c.live()) throw gone();
    store.setSync(accountId, { total: todo.length });
    let done = 0;
    await pool(todo, CONCURRENCY, async id => {
      await applyConversation(accountId, c, folders, id, ids);
      done++;
      if (done % 5 === 0 || done === todo.length) store.setSync(accountId, { done });
    });
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: writeCursor(links, ids), done: todo.length, last_sync_at: new Date().toISOString() });
    store.setAccountStatus(accountId, 'Connecté', 'ok');
  }

  async function incrementalSync(accountId) {
    const state = store.getSync(accountId);
    const cursor = readCursor(state?.history_id);
    if (!cursor) return initialSync(accountId);
    const c = client(accountId);
    const folders = await folderMap(c.graph);
    const since = new Date(Date.now() - (state.window_days || 30) * 86400000).toISOString();
    const changed = new Set(), links = {}, ids = new Map(Object.entries(cursor.ids || {}));
    try {
      for (const id of folders.tracked) links[id] = await drain(c.graph, id, cursor.links[id] || null, since, changed, ids);
    } catch (e) {
      // Curseur expiré ou dossier disparu : réimport complet de la fenêtre.
      if (e.code === 'gone_cursor' || e.code === 'not_found') return initialSync(accountId);
      throw e;
    }
    if (changed.size) await pool([...changed], CONCURRENCY, id => applyConversation(accountId, c, folders, id, ids));
    if (!c.live()) throw gone();
    store.setSync(accountId, { status: 'ok', history_id: writeCursor(links, ids), error: null, last_sync_at: new Date().toISOString() });
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
        clients.delete(accountId);archiveMetadata.delete(accountId);
        store.setAccountStatus(accountId, 'À reconnecter', 'warn');
        store.setSync(accountId, { status: 'error', error: 'Accès révoqué ou expiré : reconnecte le compte.' });
      } else {
        store.setSync(accountId, { status: 'error', error: e.message });
        if (e.code !== 'retryable') store.setAccountStatus(accountId, 'Erreur de synchronisation', 'warn');
      }
      log.error?.(`Synchronisation Outlook du compte ${accountId} : ${e.message}`);
      return false;
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
      if (!shouldPoll(id)) continue;
      run(id, s.status === 'syncing' || !readCursor(s.history_id) ? initialSync : incrementalSync);
    }
  }

  const actions = createOutlookActions({ store, client: id => client(id).graph, permissions });

  return {
    connect({profileId,name,windowDays,refreshToken,email,scopes=[OUTLOOK_SCOPES.read],expectedAccount=null,expectNew=false,authorize=()=>{}}) {
      const prepared=prepareMailConnection({store,oauth,service:'outlook',profileId,name,email,expectedAccount,expectNew,authorize,assertAccountAllowed,generation:epoch});
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
        const c=clients.get(account.id);
        if(!email && c?.email && c.live()) {
          store.upsertAccount(profileId,{name,channel:'email',svc:'outlook',address:c.email});
          store.putSecret(account.id,vault.seal(account.id,{...credentials(account.id),email:c.email}));
        }
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
    historyPage: (accountId,cursor,guard=()=>true) => serial(accountId,async()=>{
      const c=client(accountId);if(!guard())throw gone();
      const state=cursor || {folders:(await folderMap(c.graph,Infinity)).tracked,index:0,link:null,links:{}};
      if(!c.live() || !guard())throw gone();
      if(state.index>=state.folders.length)return {ids:[],next:null};
      const folder=state.folders[state.index];let page;
      try{page=await c.graph.delta(folder,state.link);}catch(error){if(error.code==='not_found')throw new HttpError(410,'Dossier d’archive supprimé.','archive_cursor_expired');throw error;}
      if(!c.live() || !guard())throw gone();
      if(!Array.isArray(page.value) || (!page['@odata.nextLink'] && !page['@odata.deltaLink']) || page['@odata.nextLink'] && page['@odata.nextLink']===state.link)throw new HttpError(502,'Pagination Outlook invalide.','retryable');
      // Preserve message→conversation mappings for removals, including old mail.
      const live=readCursor(store.getSync(accountId)?.history_id) || {links:{},ids:{}};
      const ids=new Map(Object.entries(live.ids || {})),changed=new Set();
      for(const m of page.value){const conv=m.conversationId || ids.get(m.id);if(conv)changed.add(conv);if(m.id && m.conversationId)ids.set(m.id,m.conversationId);}
      if(page['@odata.nextLink'])state.link=page['@odata.nextLink'];
      else {state.links[folder]=page['@odata.deltaLink'];state.index++;state.link=null;}
      const finished=state.index>=state.folders.length;
      // Full delta baselines replace only the matching folder links once every
      // page is read. Replaying concurrent live events after adoption is safe.
      store.setSync(accountId,{history_id:writeCursor(finished?{...live.links,...state.links}:live.links,ids)});
      return {ids:[...changed],next:finished?null:state};
    }),
    historyApply: (accountId,ids,guard=()=>true) => serial(accountId,async()=>{
      const c=client(accountId);if(!guard())throw gone();
      let cached=archiveMetadata.get(accountId);
      if(!cached || cached.client!==c || cached.expires<Date.now()){cached={client:c,expires:Date.now()+300000,value:await folderMap(c.graph,Infinity)};archiveMetadata.set(accountId,cached);}
      const folders=cached.value,live=readCursor(store.getSync(accountId)?.history_id) || {links:{},ids:{}};
      const mapping=new Map(Object.entries(live.ids || {})),scoped={...c,live:()=>c.live() && guard()};
      for(const id of ids){if(!scoped.live())throw gone();await applyConversation(accountId,scoped,folders,id,mapping);}
      if(!scoped.live())throw gone();
      store.setSync(accountId,{history_id:writeCursor(live.links,mapping)});
    }),
    syncNow: accountId => run(accountId, incrementalSync),
    notify: accountId => run(accountId, incrementalSync, {force:true}),
    permissions,
    updateMessage(id, patch) {
      const { accountId } = store.getMessageSource(id);
      return serial(accountId, () => actions.updateMessage(id, patch));
    },
    generation: accountId => epoch(accountId),
    forget(accountId, fn) {
      epochs.set(accountId, epoch(accountId) + 1);
      clients.delete(accountId);archiveMetadata.delete(accountId);
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
