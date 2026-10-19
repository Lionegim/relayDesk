import { api } from './api.js';
import { patch, delegate } from './dom.js';
import { renderApp } from './views.js';
import { NAV, GROUPS, SETTINGS, WINDOWS } from './constants.js';

const LIST_W_KEY = 'relay.listW';
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* stockage indisponible */ } },
};

const state = {
  data: null, loadError: null, toast: null,
  app: 'mail', profileId: 'anove', menu: false, accountMenu: null,
  nav: 'all', folder: null, channel: 'all', query: '', selectedId: null,
  collapsed: {}, creating: false, folderDraft: '', dragOver: null, moveOpen: false,
  listW: Number(storage.get(LIST_W_KEY)) || 340, resizing: false,
  composing: null, drafts: {}, expandedTrail: {},
  ai: null, aiTone: 'Cordial', aiIntent: '',
  group: 'all', picked: {}, focusId: null, contactQuery: '', contactSearch: false, sort: 'recent',
  c: null,
  details: {},
  confirm: null, auth: null, authPanel: null,
  composeTo: {}, newMail: null, newMailOpen: false,
  // Liste paginée côté serveur (paged=true) ; sinon instantané complet de l'ancien serveur.
  paged: false, page: null, counts: null, selectedRow: null, historyLoading: {},
  // Brouillons : version serveur, texte enregistré, état d'enregistrement et conflit, par message.
  draftMeta: {},
  // Mobile (<= 760 px) : un seul écran à la fois, tiroir pour la barre latérale.
  mobile: !!globalThis.matchMedia?.('(max-width: 760px)').matches, pane: 'list', drawer: false,
  offline: globalThis.navigator?.onLine === false,
};

const root = document.getElementById('root');
let scheduled = false;
function set(next) {
  Object.assign(state, typeof next === 'function' ? next(state) : next);
  if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; render(); }); }
}
function render() {
  if (!state.data) {
    patch(root, `<div class="loading">${state.loadError === 'offline' ? 'Hors ligne : Relay Desk a besoin du réseau pour afficher tes messages.' : state.loadError ? 'Impossible de charger les données.' : 'Chargement…'}</div>`);
    return;
  }
  const v = derive(state);
  if (v.sel) loadDetails(v.sel.id);
  const chatBefore = root.querySelector?.('.wa-timeline');
  const chatPosition = chatBefore && {
    id: chatBefore.dataset.chatId, ready: chatBefore.dataset.ready,
    nearBottom: chatBefore.scrollHeight - chatBefore.scrollTop - chatBefore.clientHeight < 64,
    top: chatBefore.scrollTop, height: chatBefore.scrollHeight,
  };
  patch(root, renderApp(state, v));
  const chatAfter = root.querySelector?.('.wa-timeline');
  // Messages plus anciens ajoutés en haut : le message lu reste au même endroit à l'écran.
  if (chatAfter && chatPosition && prependAnchor !== null && String(prependAnchor) === chatAfter.dataset.chatId && chatPosition.id === chatAfter.dataset.chatId) {
    chatAfter.scrollTop = chatPosition.top + (chatAfter.scrollHeight - chatPosition.height);
    prependAnchor = null;
    return;
  }
  if (chatAfter?.dataset.ready === 'true' &&
      (!chatPosition || chatPosition.id !== chatAfter.dataset.chatId || chatPosition.ready !== 'true' || chatPosition.nearBottom)) {
    chatAfter.scrollTop = chatAfter.scrollHeight;
  }
}

// Corps et fil sont chargés à la demande : l'état global ne contient que la liste.
const loading = new Set();
const compositionBuffers = new Map();
let selectionVersion = 0;
function rememberComposition() {
  if (state.newMail?.messageId) compositionBuffers.set(state.newMail.messageId, state.newMail);
}
let prependAnchor = null;
const known = id => state.data.messages.some(m => m.id === id) || (state.selectedRow?.id === id && state.selectedId === id);
// Identité d'un élément du fil, pour fusionner des pages sans doublon.
const trailKey = t => t.id != null ? `id:${t.id}` : `${t.at}|${t.fromMe}|${t.from}|${t.body}`;
const oldestAt = full => Math.min(...(full.trail || []).map(t => Number.isFinite(t.at) ? t.at : Infinity), Number.isFinite(full.at) ? full.at : Infinity);
// Une actualisation ne recharge que la page récente : l'historique plus ancien déjà affiché est conservé.
function mergeHistory(prev, next) {
  if (!prev || prev.failed || !prev.trail?.length) return next;
  const seen = new Set((next.trail || []).map(trailKey)), limit = oldestAt(next);
  const extra = prev.trail.filter(t => !seen.has(trailKey(t)) && Number.isFinite(t.at) && t.at <= limit);
  return extra.length ? { ...next, trail: [...(next.trail || []), ...extra], history: prev.history ?? next.history } : next;
}
function loadDetails(id) {
  if ((state.details[id] && !state.details[id].refreshing) || loading.has(id)) return;
  loading.add(id);
  api.message(id)
    .then(full => {
      if (!known(id)) return;
      const merged = mergeHistory(state.details[id], full);
      syncDraftMeta(id, merged);
      set(s => ({ details: { ...s.details, [id]: merged } }));
    })
    .catch(err => {
      if (!known(id)) return;
      set(s => ({ details: { ...s.details, [id]: s.details[id] && !s.details[id].failed
        ? { ...s.details[id], refreshing: false, stale: true } : { failed: true, trail: [] } } }));
      fail(err);
    })
    .finally(() => loading.delete(id));
}

// Rafraîchit la liste quand un compte réel est synchronisé en arrière-plan.
const REFRESH_MS = 30000;
setInterval(async () => {
  if (!state.data || state.c || state.offline || !state.data.profiles.some(p => p.accounts.some(a => ['gmail', 'outlook', 'whatsapp'].includes(a.svc)))) return;
  try { await reload({ refresh: true }); } catch { /* nouvel essai au prochain passage */ }
}, REFRESH_MS);
setInterval(async () => {
  if (!state.data || state.c || state.offline || !state.data.profiles.some(p => p.accounts.some(a => a.svc === 'whatsapp' && a.sync?.status === 'syncing'))) return;
  try { await reload({ refresh: true }); } catch { /* progression au prochain passage */ }
}, 3000);

// ---------- Liste paginée ----------

const PAGE = 50;
let listRequest = 0, searchTimer = null;
const listKey = s => JSON.stringify([s.profileId, s.folder ? 'all' : s.nav, s.channel, s.folder || '', s.query.trim()]);
const listParams = (s, extra) => ({ paged: 1, profile: s.profileId, nav: s.folder ? 'all' : s.nav, channel: s.channel, folder: s.folder || undefined, q: s.query.trim() || undefined, limit: PAGE, ...extra });

// Charge la liste selon les filtres courants. Une réponse arrivée après un changement de filtre est ignorée.
// append : page suivante. refresh : actualisation de ce qui est déjà affiché. Les erreurs remontent à l'appelant.
async function reload({ append = false, refresh = false } = {}) {
  const key = listKey(state), request = ++listRequest;
  const items = state.paged ? state.data?.messages || [] : [];
  const cursor = append ? state.page?.nextCursor : undefined;
  if (append && (!state.paged || !cursor)) return false;
  // Actualisation : autant d'éléments que ceux affichés, dans la limite du serveur (100 par page).
  const limit = refresh && state.paged ? Math.min(100, Math.max(PAGE, Math.ceil(items.length / PAGE) * PAGE)) : PAGE;
  if (state.paged) set({ page: { ...state.page, key, loading: append ? 'more' : true, error: null } });
  let data;
  try {
    data = await api.state(listParams(state, { limit, cursor }));
  } catch (e) {
    if (request === listRequest && state.paged) set({ page: { ...state.page, loading: false, error: e.message } });
    throw e;
  }
  if (request !== listRequest || key !== listKey(state)) return false;
  if (!data.page) { applyData(data); return true; } // serveur sans pagination : filtres appliqués localement
  const merged = append ? [...items, ...data.messages.filter(m => !items.some(x => x.id === m.id))] : data.messages;
  applyData({ ...data, messages: merged }, { paged: true, counts: data.counts || null, page: { ...data.page, key, loading: false, error: null } });
  if (!data.profiles.some(p => p.id === state.profileId) && data.profiles[0]) {
    set({ profileId: data.profiles[0].id, selectedId: null, selectedRow: null });
    return reload();
  }
  if (!append && !refresh && state.selectedId == null && !state.mobile && merged[0]) set({ selectedId: merged[0].id, selectedRow: merged[0] });
  return true;
}
// Chargement déclenché par l'interface : erreur affichée, rien n'est retenté automatiquement.
const loadList = opts => reload(opts).catch(fail);
function filtersChanged(next) {
  set(next);
  clearTimeout(searchTimer);
  if (state.paged) loadList();
}

function applyData(data, extra = {}) {
  const before = new Map((state.data?.messages || []).map(m => [m.id, m.sortAt + ':' + m.count]));
  const details = Object.fromEntries(Object.entries(state.details).flatMap(([id, full]) => {
    const m = data.messages.find(x => x.id === Number(id)) || (Number(id) === state.selectedId && state.selectedRow?.id === state.selectedId ? state.selectedRow : null);
    if (!m) return [];
    if (!full.stale && before.get(m.id) === m.sortAt + ':' + m.count) return [[id, full]];
    // Garder les bulles pendant le rechargement préserve l'ancrage de lecture.
    return m.channel === 'whatsapp' && !full.failed ? [[id, { ...full, refreshing: true }]] : [];
  }));
  const a = state.ai, updated = a && (data.messages.find(m => m.id === a.forId) || (state.selectedRow?.id === a.forId ? state.selectedRow : null));
  const ai = a && (!updated || (before.has(updated.id) && before.get(updated.id) !== updated.sortAt + ':' + updated.count)) ? null : a;
  // La ligne sélectionnée reste connue même hors de la page affichée (même profil).
  const row = data.messages.find(m => m.id === state.selectedId);
  set({ data, details, ai, ...(row ? { selectedRow: row } : {}), ...extra });
}

// ---------- Historique d'un fil ----------

async function loadOlder(id) {
  const cur = state.details[id], cursor = cur?.history?.nextCursor;
  if (!cursor || state.historyLoading[id]) return;
  set(s => ({ historyLoading: { ...s.historyLoading, [id]: true } }));
  try {
    const older = await api.message(id, { limit: PAGE, before: cursor });
    const now = state.details[id];
    if (!now || now.history?.nextCursor !== cursor) return; // fil rechargé entre-temps
    const seen = new Set(now.trail.map(trailKey));
    const extra = (older.trail || []).filter(t => !seen.has(trailKey(t)));
    if (state.selectedId === id && state.data.messages.concat(state.selectedRow || []).some(m => m.id === id && m.channel === 'whatsapp')) prependAnchor = id;
    set(s => ({ details: { ...s.details, [id]: { ...now, trail: [...now.trail, ...extra], history: older.history || { hasMore: false, nextCursor: null } } } }));
  } catch (e) {
    // Fil modifié depuis le chargement : on le recharge (l'historique déjà affiché est conservé) au lieu d'insister.
    if (e.status === 409 && e.code === 'history_changed' && state.details[id]) {
      set(s => ({ details: { ...s.details, [id]: { ...s.details[id], refreshing: true } } }));
      loadDetails(id);
    } else fail(e);
  }
  finally { set(s => ({ historyLoading: { ...s.historyLoading, [id]: false } })); }
}

// ---------- Brouillons enregistrés sur le serveur ----------

const AUTOSAVE_MS = 1500;
const draftTimers = new Map();
// Version fournie par le serveur (monotone, jamais supposée) ; null pour un ancien serveur sans versions.
const versionOf = full => Number.isInteger(full?.draftVersion) ? full.draftVersion : Number.isInteger(full?.draft?.version) ? full.draft.version : null;
const withBase = (input, version) => (version === null || version === undefined ? input : { ...input, baseVersion: version });
const serverText = id => state.details[id]?.draft?.text ?? '';
const draftText = id => state.drafts[id] ?? serverText(id);
const setMeta = (id, patch) => set(s => ({ draftMeta: { ...s.draftMeta, [id]: { ...s.draftMeta[id], ...patch } } }));
const dirty = id => { const m = state.draftMeta[id]; return !!m && (m.saving || m.conflict || draftText(id) !== (m.savedText ?? serverText(id))); };

// Version reçue du serveur. Si elle change alors que le texte local n'est pas enregistré : conflit, jamais d'écrasement.
function syncDraftMeta(id, full) {
  if (full.failed) return;
  const meta = state.draftMeta[id], version = versionOf(full), text = full.draft?.text ?? '';
  if (!meta || meta.version === undefined) { state.draftMeta = { ...state.draftMeta, [id]: { ...meta, version, savedText: text, savedAt: full.draft?.savedAt } }; return; }
  if (meta.saving || version === meta.version) return;
  if (state.drafts[id] !== undefined && state.drafts[id] !== meta.savedText) {
    state.draftMeta = { ...state.draftMeta, [id]: { ...meta, conflict: true } };
    return;
  }
  const drafts = { ...state.drafts };
  delete drafts[id];
  state.drafts = drafts;
  state.draftMeta = { ...state.draftMeta, [id]: { ...meta, version, savedText: text, savedAt: full.draft?.savedAt, conflict: false, error: null } };
}

function scheduleAutosave(id) {
  clearTimeout(draftTimers.get(id));
  draftTimers.set(id, setTimeout(() => { draftTimers.delete(id); saveDraftNow(id); }, AUTOSAVE_MS));
}

// Un seul enregistrement en vol par message ; le texte modifié pendant la requête reste « non enregistré »
// puis part au passage suivant.
async function saveDraftNow(id, { overwrite = false } = {}) {
  const full = state.details[id], meta = state.draftMeta[id] || {};
  if (!full || full.failed || meta.version === undefined) return;
  if (meta.saving) { setMeta(id, { again: true }); return; }
  if (meta.conflict && !overwrite) return;
  const text = draftText(id);
  if (!overwrite && text === (meta.savedText ?? serverText(id)) && !meta.error) return;
  const mode = (state.selectedId === id && state.composing) || full.draft?.mode || 'reply';
  const to = mode === 'forward' ? (state.composeTo[id] ?? full.draft?.to ?? '') : null;
  setMeta(id, { saving: true, again: false, error: null });
  try {
    const draft = await api.saveDraft(id, withBase({ text, mode, to }, meta.version));
    if (draft.previousDraftKept) notify('Un ancien brouillon est conservé chez le fournisseur.');
    const cur = state.details[id];
    if (cur) cur.draft = draft;
    const row = state.data.messages.find(m => m.id === id) || (state.selectedRow?.id === id ? state.selectedRow : null);
    if (row) row.draft = { savedAt: draft.savedAt, gmail: draft.gmail, synced: draft.synced ?? draft.gmail };
    const again = state.draftMeta[id]?.again;
    setMeta(id, { saving: false, again: false, version: Number.isInteger(draft.version) ? draft.version : meta.version, savedText: text, savedAt: draft.savedAt, conflict: false, error: null });
    if (again || draftText(id) !== text) scheduleAutosave(id);
  } catch (e) {
    if (e.status === 409 && e.code === 'draft_conflict') setMeta(id, { saving: false, again: false, conflict: true });
    else setMeta(id, { saving: false, again: false, error: e.message });
  }
}

// Conflit : recharger explicitement la version du serveur (le texte local est abandonné) ou la remplacer par le texte local.
async function resolveConflict(id, keepMine) {
  let full;
  try { full = await api.message(id); } catch (e) { return fail(e); }
  if (!known(id)) return;
  const merged = mergeHistory(state.details[id], full);
  state.details = { ...state.details, [id]: merged };
  const version = versionOf(full), text = full.draft?.text ?? '';
  if (keepMine) {
    setMeta(id, { version, savedText: text, conflict: false, error: null });
    return saveDraftNow(id, { overwrite: true });
  }
  set(s => {
    const drafts = { ...s.drafts };
    delete drafts[id];
    return { drafts, draftMeta: { ...s.draftMeta, [id]: { version, savedText: text, savedAt: full.draft?.savedAt, conflict: false, error: null } } };
  });
}

// ---------- Mobile : couches empilées dans l'historique du navigateur ----------

const layers = [];
function pushLayer(name) {
  if (!state.mobile || layers.at(-1) === name) return;
  layers.push(name);
  try { history.pushState?.({ relay: name, depth: layers.length }, ''); } catch { /* historique indisponible */ }
}
function closeLayer(name) {
  if (name === 'reader') set({ pane: 'list', moveOpen: false });
  else if (name === 'compose') set({ composing: null });
  else if (name === 'ai') { aiRequest++; set({ ai: null }); }
  else if (name === 'drawer') set({ drawer: false, menu: false });
  else if (name === 'confirm') { if (state.confirm && !state.confirm.busy) set({ newMailOpen: !!state.confirm.newMail, confirm: null }); }
}
// Bouton de l'interface : passe par l'historique du navigateur s'il porte cette couche, pour rester cohérent.
function backFrom(name) {
  if (layers.at(-1) === name && typeof history.back === 'function') { history.back(); return; }
  const i = layers.lastIndexOf(name);
  if (i >= 0) layers.splice(i, 1);
  closeLayer(name);
}
function onPopState() {
  const name = layers.pop();
  if (!name) return;
  // Un envoi en cours n'est jamais annulé par le bouton retour.
  if (name === 'confirm' && state.confirm?.busy) { pushLayer('confirm'); return; }
  closeLayer(name);
}

let toastTimer;
function notify(text) {
  clearTimeout(toastTimer);
  set({ toast: text, toastOk: true });
  toastTimer = setTimeout(() => set({ toast: null, toastOk: false }), 4000);
}
function fail(err) {
  clearTimeout(toastTimer);
  state.toastOk = false;
  set({ toast: err.message || String(err) });
  toastTimer = setTimeout(() => set({ toast: null }), 5000);
}

// ---------- Données dérivées ----------

function folderSet(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    state.data.folders.forEach(f => { if (out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } });
  }
  return out;
}

function flatFolders(s) {
  const rows = [];
  const walk = (parent, depth) => s.data.folders.filter(f => f.p === s.profileId && f.parent === parent).forEach(f => {
    rows.push({ f, depth, kids: s.data.folders.some(c => c.parent === f.id) });
    if (!s.collapsed[f.id]) walk(f.id, depth + 1);
    if (s.creating === f.id) rows.push({ input: true, depth: depth + 1 });
  });
  walk(null, 0);
  if (s.creating === 'root') rows.push({ input: true, depth: 0 });
  return rows;
}

function derive(s) {
  const d = s.data;
  const profile = d.profiles.find(p => p.id === s.profileId) || d.profiles[0];
  // Mode paginé : le serveur a déjà filtré (profil, vue, canal, dossier, recherche) ; les compteurs viennent du serveur.
  const inProfile = s.paged ? d.messages : d.messages.filter(m => m.p === s.profileId && !m.archived);
  const byNav = s.paged ? inProfile : s.folder
    ? inProfile.filter(m => folderSet(s.folder).has(m.folderId))
    : inProfile.filter(m => s.nav === 'all' || (s.nav === 'unread' && m.unread) || (s.nav === 'todo' && m.flagged) || (s.nav === 'drafts' && m.draft));
  const q = s.query.trim().toLowerCase();
  const list = s.paged ? byNav : byNav.filter(m => (s.channel === 'all' || m.channel === s.channel) && (!q || (m.from + m.subject + m.preview).toLowerCase().includes(q)));
  const sel = inProfile.find(m => m.id === s.selectedId)
    || (s.paged && s.selectedRow?.id === s.selectedId && s.selectedRow.p === s.profileId && !s.selectedRow.archived ? s.selectedRow : null);
  const counts = s.paged && s.counts ? s.counts : {
    all: inProfile.length, unread: inProfile.filter(m => m.unread).length, todo: inProfile.filter(m => m.flagged).length,
    drafts: inProfile.filter(m => m.draft).length, folders: null,
  };

  const contactsMine = d.contacts.filter(c => c.p === s.profileId);
  const cq = s.contactQuery.trim().toLowerCase();
  const contacts = contactsMine
    .filter(c => (s.group === 'all' || c.g.includes(s.group)) && (!cq || (c.name + c.title).toLowerCase().includes(cq)))
    .sort(s.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.order - b.order);

  return {
    profile, inProfile, byNav, list, sel, contactsMine, contacts, counts,
    // Canaux proposés : en mode paginé, ceux des comptes du profil (la page ne les contient pas tous).
    channels: s.paged ? [...new Set(profile.accounts.map(a => a.channel))] : [...new Set(byNav.map(m => m.channel))],
    picked: contacts.filter(c => s.picked[c.id]),
    folders: flatFolders(s),
    folderCount: id => {
      if (counts.folders) return counts.folders[id] || 0;
      const set = folderSet(id); return inProfile.filter(m => set.has(m.folderId)).length;
    },
    viewTitle: s.folder ? (d.folders.find(f => f.id === s.folder)?.name || '') : NAV.find(n => n[0] === s.nav)[1],
    groupTitle: GROUPS.find(g => g[0] === s.group)[1],
    compact: SETTINGS.density === 'compacte',
    showTriage: SETTINGS.showTriage,
  };
}

// ---------- Mises à jour serveur (optimistes) ----------

function patchMessage(id, fields) {
  const m = state.data.messages.find(x => x.id === id);
  if (!m) return;
  const before = Object.fromEntries(Object.keys(fields).map(k => [k, m[k]]));
  Object.assign(m, fields);
  set({});
  const d = state.details[id];
  if (d) Object.assign(d, fields);
  api.updateMessage(id, fields).catch(err => { Object.assign(m, before); if (d) Object.assign(d, before); fail(err); });
}

function commitFolder() {
  const s = state, name = s.folderDraft.trim();
  if (s.creating === false) return;
  const parentId = s.creating === 'root' ? null : s.creating;
  set({ creating: false, folderDraft: '' });
  if (!name) return;
  api.createFolder({ profileId: s.profileId, name, parentId })
    .then(folder => { state.data.folders.push(folder); set({}); })
    .catch(fail);
}

// ---------- Assistant ----------

let aiRequest = 0;
async function aiRun(regenerate = false) {
  const s = state, sel = derive(s).sel;
  if (!s.ai || !sel || s.ai.loading || s.ai.memoryBusy || !s.data.ai?.configured) return;
  const mode = s.ai.mode, forId = sel.id, request = ++aiRequest, version = selectionVersion, profileId = s.profileId;
  set({ ai: { ...s.ai, loading: true, result: null, error: null, forId } });
  let result = null, error = null;
  try {
    result = mode === 'summary' ? await api.summarize(forId, regenerate)
      : mode === 'classify' ? await api.classify(forId, regenerate) : await api.draftReply(forId, s.aiTone, s.aiIntent);
  } catch (e) {
    error = e.message;
  }
  if (request === aiRequest && version === selectionVersion && profileId === state.profileId && state.selectedId === forId && state.ai?.forId === forId && state.ai.mode === mode) {
    if (result && state.details[forId] && mode !== 'draft') state.details[forId].aiResults = { ...state.details[forId].aiResults, [mode]: result };
    set({ ai: { ...state.ai, loading: false, result, error, folderId: result?.folderId ?? null } });
  }
}

async function changeReplyMemory(input) {
  const sel=derive(state).sel, a=state.ai;
  if(!sel || !a || a.memoryBusy) return;
  const id=sel.id, version=selectionVersion, request=++aiRequest;
  set({ai:{...a,memoryBusy:true,loading:false,result:null,error:null,memoryConfirm:false}});
  try {
    const memory=await api.changeReplyMemory(id,input);
    if(version!==selectionVersion || request!==aiRequest || state.selectedId!==id || state.ai?.forId!==id) return;
    if(state.details[id]) state.details[id].replyMemory=memory;
    set({ai:{...state.ai,memoryBusy:false}});
  } catch(e) {
    if(version===selectionVersion && request===aiRequest && state.ai?.forId===id) set({ai:{...state.ai,memoryBusy:false,error:e.message}});
  }
}

function aiOpen(mode) {
  const sel = derive(state).sel;
  if (!sel) return;
  aiRequest++;
  const result = state.details[sel.id]?.aiResults?.[mode] || null;
  const wasOpen = !!state.ai;
  set({ ai: { mode, result, folderId: result?.folderId ?? null, error: null, loading: false, forId: sel.id }, moveOpen: false });
  if (!wasOpen) pushLayer('ai');
}

// ---------- Assistant de connexion ----------

let syncTimer, wizardVersion = 0, linkRequest = 0;
function svcInit(key, name) {
  const def = state.data.services[key], fields = {};
  (def.fields || []).forEach(f => { fields[f[0]] = f[2]; });
  return { step: 'config', svc: key, name: name || def.name, fields, perms: def.auth === 'qr' ? { read: true, drafts: true, send: true } : { read: true }, ...(def.auth === 'qr' ? { win: 7 } : {}) };
}
function openWizard(svc, name, account = null) {
  const c = { wizardId: ++wizardVersion, step: 'pick', svc: null, profile: state.profileId, name: '', perms: { read: true }, win: 30, fields: {}, progress: 0, fromAccount: !!name };
  if (svc) Object.assign(c, svcInit(svc, name));
  if (account) Object.assign(c, { accountId: account.id, win: svc === 'whatsapp' ? 7 : account.windowDays || 30, perms: Object.fromEntries((svc === 'whatsapp' ? ['read','drafts','send'] : ['read', ...(account.perms || [])]).map(p => [p, true])) });
  set({ c, menu: false, accountMenu: null });
}
const setC = f => set(s => ({ c: { ...s.c, ...(typeof f === 'function' ? f(s.c) : f) } }));
function closeWizard() {
  clearInterval(syncTimer);
  linkRequest++;
  const c = state.c;
  if (c?.svc === 'whatsapp' && c.linkId && c.step !== 'done') api.cancelWhatsAppLink(c.linkId).catch(() => {});
  set({ c: null });
}

async function startWhatsAppLink() {
  const c = state.c;
  if (!c || c.busy || c.linkId) return;
  const request = ++linkRequest;
  const current = () => state.c?.wizardId === c.wizardId && state.c?.svc === 'whatsapp' && request === linkRequest;
  setC({ busy: true, error: null, link: null });
  try {
    const { linkId } = await api.startWhatsAppLink({ profileId: c.profile, name: c.name.trim(), windowDays: 7, ...(c.accountId ? { accountId: c.accountId, reconnect: true } : {}) });
    if (!current()) {
      await api.cancelWhatsAppLink(linkId); return;
    }
    setC({ busy: false, linkId });
    let polling = false;
    const poll = async () => {
      if (polling || state.c?.linkId !== linkId) return;
      polling = true;
      try {
        const link = await api.whatsAppLink(linkId);
        if (state.c?.linkId !== linkId) return;
        setC({ link, error: link.status === 'error' ? link.error || 'Liaison interrompue. Réessaie avec un nouveau QR code.' : null });
        if (link.status === 'connected') {
          await reload({ refresh: true });
          if (current() && state.c?.linkId === linkId) {
            clearInterval(syncTimer);
            setC({ step: 'done', accountId: link.accountId, progress: 100, real: { messages: link.messages || 0, threads: link.threads || 0, todo: 0 } });
          }
        } else if (link.status === 'error') clearInterval(syncTimer);
      } catch (e) { if (state.c?.linkId === linkId) setC({ error: e.message }); }
      finally { polling = false; }
    };
    clearInterval(syncTimer); syncTimer = setInterval(poll, 1500); poll();
  } catch (e) { if (current()) setC({ busy: false, error: e.message }); }
}

// Gmail : autorisation réelle dans Google (pleine page), puis suivi de l'import côté serveur.
async function startProviderAuth() {
  const c = state.c;
  if (!state.data.integrations?.[c.svc]?.configured) {
    setC({ error: `Connexion ${state.data.services[c.svc].name} non configurée : consulte sa documentation de connexion.` });
    return;
  }
  const perms = state.data.services[c.svc].available.filter(p => c.perms[p]);
  if(state.auth?.legacy){location.href=(c.svc==='outlook'?'/oauth/microsoft/start?':'/oauth/google/start?')+new URLSearchParams({profile:c.profile,name:c.name.trim(),win:c.win,perms:perms.join(','),...(c.accountId?{account:c.accountId}:{})});return;}
  try {const result=await api.startOAuth(c.svc==='outlook'?'microsoft':'google',{ profile:c.profile,name:c.name.trim(),win:c.win,perms:perms.join(','),...(c.accountId?{account:c.accountId}:{}) });location.assign(result.url);}catch(error){setC({busy:false,error:error.message});}
}
function trackImport(accountId) {
  clearInterval(syncTimer);
  const poll = async () => {
    let p;
    try { p = await api.syncProgress(accountId); } catch (e) { return setC({ error: e.message }); }
    if (!state.c) return clearInterval(syncTimer);
    if (p.status === 'error') {
      clearInterval(syncTimer);
      return setC({ step: 'auth', error: p.error || 'La synchronisation a échoué.' });
    }
    const progress = p.status === 'ok' ? 100 : p.total ? Math.max(2, Math.round(p.done / p.total * 98)) : 2;
    setC({ progress, real: p });
    if (p.status === 'ok') {
      clearInterval(syncTimer);
      await reload({ refresh: true });
      if (state.c) setC({ step: 'done' });
    }
  };
  poll();
  syncTimer = setInterval(poll, 700);
}
function resumeFromRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('connect') && !params.has('connect_error')) return;
  history.replaceState(null, '', '/');
  const base = { svc: params.get('provider') || params.get('connect') || 'gmail', perms: { read: true }, fields: {}, progress: 0, fromAccount: false };
  if (params.has('connect_error')) {
    set({ c: { ...base, step: 'auth', profile: state.profileId, name: state.data.services[base.svc]?.name || 'Messagerie', win: 30, error: params.get('connect_error') } });
    return;
  }
  const accountId = Number(params.get('account')), profile = params.get('profile');
  const acc = state.data.profiles.find(p => p.id === profile)?.accounts.find(a => a.id === accountId);
  if (!acc) return;
  set({ profileId: profile, selectedId: firstOf(profile), app: 'mail', folder: null, c: { ...base, perms: Object.fromEntries((acc.perms || ['read']).map(p => [p, true])), step: 'sync', profile, name: acc.name, win: Number(params.get('win')) || 30, accountId } });
  trackImport(accountId);
}
function startSync() {
  setC({ step: 'sync', progress: 0 });
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!state.c) return clearInterval(syncTimer);
    const progress = Math.min(100, state.c.progress + 4);
    setC({ progress });
    if (progress < 100) return;
    clearInterval(syncTimer);
    const c = state.c;
    api.connectAccount(c.profile, { name: c.name, svc: c.svc })
      .then(acc => {
        const p = state.data.profiles.find(x => x.id === c.profile);
        const i = p.accounts.findIndex(a => a.name === acc.name);
        if (i >= 0) p.accounts[i] = acc; else p.accounts.push(acc);
        if (state.c) setC({ step: 'done' });
      })
      .catch(err => { if (state.c) setC({ step: 'auth', error: err.message }); });
  }, 90);
}

// Un même compositeur pour tous les comptes email pris en charge.
async function saveNewMail() {
  let c = state.newMail;
  if (!c || c.busy || !c.accountId) return null;
  set({ newMail: { ...c, busy: true, error: null } });
  try {
    if (!c.messageId) {
      const m = await api.createComposition(c.accountId);
      c = { ...c, messageId: m.id, version: versionOf(m) };
      set({ newMail: { ...c, busy: true } });
    }
    const input = { mode: 'new', to: c.to, cc: c.cc, subject: c.subject, text: c.text };
    const draft = await api.saveDraft(c.messageId, withBase(input, c.version));
    if (draft.previousDraftKept) notify('Un ancien brouillon est conservé chez le fournisseur.');
    c = { ...c, version: Number.isInteger(draft.version) ? draft.version : c.version };
    set({ newMail: { ...state.newMail, messageId: c.messageId, version: c.version, busy: false, savedAt: draft.savedAt, synced: draft.synced ?? draft.gmail, error: null, conflict: false } });
    try { await reload({ refresh: true }); } catch { /* l'enregistrement est déjà confirmé */ }
    return { c, input: withBase(input, c.version) };
  } catch (e) {
    // Conflit : le texte saisi reste affiché ; rien n'est écrasé sans action explicite.
    const conflict = e.status === 409 && e.code === 'draft_conflict';
    set({ newMail: { ...state.newMail, busy: false, conflict, error: conflict ? 'Ce brouillon a été modifié sur un autre appareil. Ton texte est conservé ici : copie-le si besoin, puis rouvre le brouillon pour charger la version enregistrée.' : e.message } });
    return null;
  }
}

// ---------- Actions ----------

const num = v => Number(v);
const firstOf = profileId => state.data.messages.find(m => m.p === profileId && !m.archived)?.id ?? null;

const actions = {
  authDevices: async()=>{try{set({authPanel:await api.sessions()});}catch(e){fail(e);}},
  authClose: ()=>set({authPanel:null}),
  authLogout: async()=>{try{await api.logout();location.replace('/login');}catch(e){fail(e);}},
  authRevoke: async({id})=>{try{await api.revokeSession(id);if(id===state.auth?.sessionId)location.replace('/login');else set({authPanel:await api.sessions()});}catch(e){fail(e);}},
  noop: () => {},
  newMessage: () => {
    const accounts = derive(state).profile.accounts.filter(a => a.channel === 'email' && a.perms?.includes('read'));
    if (state.newMail?.accountId && accounts.some(a => a.id === state.newMail.accountId)) return set({ newMailOpen: true });
    const accountId = accounts.find(a => a.id === derive(state).sel?.accountId)?.id ?? accounts[0]?.id ?? null;
    set({ newMailOpen: true, newMail: { accountId, to: '', cc: '', subject: '', text: '', busy: false } });
  },
  newMailField: ({ field }, e) => { if (!state.newMail?.busy) set({ newMail: { ...state.newMail, [field]: field === 'accountId' ? Number(e.target.value) : e.target.value, savedAt: null, error: null } }); },
  closeNewMail: () => { if (!state.newMail?.busy) { rememberComposition(); set({ newMailOpen: false }); } },
  newMailConnect: () => { set({ newMailOpen: false }); openWizard(); },
  saveNewMail: () => saveNewMail(),
  previewNewMail: async () => {
    if (state.confirm) return;
    const saved = await saveNewMail();
    if (!saved) return;
    const { c, input } = saved;
    set({ newMail: { ...state.newMail, busy: true } });
    try {
      const preview = await api.previewSend(c.messageId, input);
      set({ newMailOpen: false, newMail: { ...state.newMail, busy: false }, confirm: { kind: 'send', newMail: true, messageId: c.messageId, input, preview, busy: false, error: null } });
      pushLayer('confirm');
    } catch (e) { set({ newMail: { ...state.newMail, busy: false, error: e.message } }); }
  },
  aiNewMail: async () => {
    const saved = await saveNewMail();
    if (!saved) return;
    set({ newMail: { ...state.newMail, busy: true } });
    try {
      const r = await api.draftReply(saved.c.messageId, 'Cordial', 'Améliore ce nouveau message sans inventer de faits.');
      set({ newMail: { ...state.newMail, busy: false, text: r.text, savedAt: null } });
    } catch (e) { set({ newMail: { ...state.newMail, busy: false, error: e.message } }); }
  },
  toggleProfileMenu: () => set({ menu: !state.menu, accountMenu: null }),
  selectProfile: ({ id }) => {
    selectionVersion++; rememberComposition();
    if (state.drawer) backFrom('drawer');
    filtersChanged({ newMailOpen: false, profileId: id, menu: false, accountMenu: null, picked: {}, group: 'all', channel: 'all', query: '', selectedId: state.paged ? null : firstOf(id), selectedRow: null, folder: null, ai: null, moveOpen: false, creating: false, composing: null, pane: 'list' });
  },
  selectApp: ({ app }) => { if (state.drawer) backFrom('drawer'); set({ app, ai: null, moveOpen: false }); },
  selectNav: ({ id }) => { if (state.drawer) backFrom('drawer'); filtersChanged({ nav: id, channel: 'all', folder: null }); },
  openDrawer: () => { set({ drawer: true }); pushLayer('drawer'); },
  closeDrawer: () => backFrom('drawer'),
  mobileBack: () => backFrom('reader'),
  loadMore: () => loadList({ append: true }),
  retryList: () => loadList(),
  loadOlder: ({ id }) => loadOlder(Number(id)),
  draftReload: ({ id }) => resolveConflict(Number(id), false),
  draftKeepMine: ({ id }) => resolveConflict(Number(id), true),
  selectGroup: ({ id }) => { if (state.drawer) backFrom('drawer'); set({ group: id, app: 'contacts' }); },

  // Dossiers
  newRootFolder: () => set({ creating: 'root', folderDraft: '' }),
  addSubfolder: ({ id }, e) => { e.stopPropagation(); set(s => ({ creating: id, folderDraft: '', collapsed: { ...s.collapsed, [id]: false } })); },
  toggleFolder: ({ id }, e) => { e.stopPropagation(); set(s => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })); },
  selectFolder: ({ id }) => { if (state.drawer) backFrom('drawer'); filtersChanged({ folder: id, channel: 'all' }); },
  folderDraft: (_, e) => set({ folderDraft: e.target.value }),
  folderKey: (_, e) => {
    if (e.key === 'Enter') commitFolder();
    if (e.key === 'Escape') set({ creating: false, folderDraft: '' });
  },
  folderBlur: () => commitFolder(),
  folderDragOver: ({ id }, e) => { e.preventDefault(); if (state.dragOver !== id) set({ dragOver: id }); },
  folderDragLeave: () => set({ dragOver: null }),
  folderDrop: ({ id }, e) => {
    e.preventDefault();
    const msg = Number(e.dataTransfer.getData('text/plain'));
    set({ dragOver: null });
    if (msg) patchMessage(msg, { folderId: id });
  },
  threadDragStart: ({ id }, e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; },
  toggleMove: () => set({ moveOpen: !state.moveOpen }),
  moveTo: ({ id }) => {
    const sel = derive(state).sel;
    if (sel) patchMessage(sel.id, { folderId: id || null });
    set({ moveOpen: false });
  },

  // Comptes
  openAccount: ({ name }) => {
    const acc = derive(state).profile.accounts.find(a => a.name === name);
    if (acc && state.data.services[acc.svc]?.real) return set({ accountMenu: state.accountMenu === acc.id ? null : acc.id, menu: false });
    if (!acc || acc.c === 'ok' || !acc.svc) return;
    const def = state.data.services[acc.svc];
    if (def.disabled) openWizard(); else openWizard(acc.svc, acc.name);
  },
  accountPermissions: ({ id }) => {
    const acc = derive(state).profile.accounts.find(a => a.id === Number(id));
    if (acc) openWizard(acc.svc, acc.name, acc);
  },
  accountSync: async ({ id }) => {
    set({ accountMenu: null });
    try {
      await api.syncNow(Number(id));
      await reload({ refresh: true });
      set({ toast: 'Synchronisation demandée.' });
    } catch (e) { fail(e); }
  },
  openConnect: () => openWizard(),

  // Liste
  // Recherche côté serveur, après une courte pause de frappe.
  search: (_, e) => {
    set({ query: e.target.value });
    if (!state.paged) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadList(), 250);
  },
  selectChannel: ({ id }) => filtersChanged({ channel: id }),
  selectThread: async ({ id }) => {
    const version = ++selectionVersion, profileId = state.profileId;
    rememberComposition();
    const m = state.data.messages.find(x => x.id === num(id));
    aiRequest++;
    set({ selectedId: m.id, selectedRow: m, moveOpen: false, composing: null, ai: null, pane: 'reader' });
    pushLayer('reader');
    if (m.kind === 'new') {
      try {
        const cached = compositionBuffers.get(m.id);
        if (cached) { set({ newMailOpen: true, newMail: cached }); return; }
        const full = await api.message(m.id);
        if (selectionVersion !== version || state.profileId !== profileId || state.selectedId !== m.id) return;
        set({ newMailOpen: true, newMail: { messageId: full.id, version: versionOf(full), accountId: full.accountId, to: full.draft?.to || '', cc: full.draft?.cc || '', subject: full.subject, text: full.draft?.text || '', savedAt: full.draft?.savedAt, synced: full.draft?.synced, busy: false } });
      } catch (e) { fail(e); }
      return;
    }
    if (m.unread) patchMessage(m.id, { unread: false });
  },
  startResize: (_, e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = state.listW;
    const move = ev => set({ listW: Math.max(280, Math.min(720, window.innerWidth - 220 - 420, w0 + ev.clientX - x0)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      storage.set(LIST_W_KEY, state.listW);
      set({ resizing: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    set({ resizing: true });
  },
  resetWidth: () => { storage.set(LIST_W_KEY, 380); set({ listW: 380 }); },

  // Lecture
  compose: ({ mode }) => {
    if (derive(state).sel?.channel === 'whatsapp' && mode !== 'reply') return;
    set({ composing: mode });
    if (derive(state).sel?.channel !== 'whatsapp') pushLayer('compose');
  },
  closeComposer: () => { if (layers.includes('compose')) backFrom('compose'); else set({ composing: null }); },
  composeTo: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ composeTo: { ...s.composeTo, [id]: v } })); scheduleAutosave(id); },
  draft: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ drafts: { ...s.drafts, [id]: v } })); scheduleAutosave(id); },
  saveDraft: () => {
    const id = derive(state).sel?.id;
    if (id == null) return;
    clearTimeout(draftTimers.get(id));
    saveDraftNow(id);
  },
  toggleFlag: () => { const sel = derive(state).sel; if (sel) patchMessage(sel.id, { flagged: !sel.flagged }); },
  toggleRead: () => { const sel = derive(state).sel; if (sel) patchMessage(sel.id, { unread: !sel.unread }); },
  archive: () => {
    const v = derive(state);
    if (!v.sel) return;
    const next = v.list.find(m => m.id !== v.sel.id);
    patchMessage(v.sel.id, { archived: true });
    if (state.mobile) { set({ composing: null }); backFrom('reader'); return; }
    set({ selectedId: next?.id ?? null, selectedRow: next || null, composing: null });
  },
  toggleTrail: ({ trail }) => set(s => ({ expandedTrail: { ...s.expandedTrail, [trail]: !s.expandedTrail[trail] } })),

  // Assistant IA
  aiSummary: () => aiOpen('summary'),
  aiDraft: () => aiOpen('draft'),
  aiMemoryToggle: () => {const sel=derive(state).sel;const memory=state.details[sel?.id]?.replyMemory;if(memory?.available) return changeReplyMemory({enabled:!memory.enabled});},
  aiMemoryReset: () => set({ai:{...state.ai,memoryConfirm:true}}),
  aiMemoryCancel: () => set({ai:{...state.ai,memoryConfirm:false}}),
  aiMemoryConfirm: () => changeReplyMemory({reset:true}),
  aiClassify: () => aiOpen('classify'),
  aiTab: ({ mode }) => { if (state.ai?.mode !== mode) aiOpen(mode); },
  aiClose: () => { if (layers.includes('ai')) backFrom('ai'); else { aiRequest++; set({ ai: null }); } },
  aiTone: ({ tone }) => { aiRequest++; set({ aiTone: tone, ai: state.ai ? { ...state.ai, loading: false, result: null } : null }); },
  aiIntent: (_, e) => { aiRequest++; set({ aiIntent: e.target.value, ai: state.ai ? { ...state.ai, loading: false, result: null } : null }); },
  aiRun: () => aiRun(),
  aiRegenerate: () => aiRun(true),
  aiFolder: (_, e) => set({ ai: { ...state.ai, folderId: e.target.value || null } }),
  aiApply: async () => {
    const a = state.ai, sel = derive(state).sel;
    if (!sel || !a?.result || a.loading || a.forId !== sel.id) return;
    set({ ai: { ...a, loading: true, error: null } });
    try {
      const applied = await api.applyClassification(sel.id, a.result.proposalId, a.folderId);
      if (state.details[sel.id]) delete state.details[sel.id];
      await reload({ refresh: true });
      if (state.ai === a || state.ai?.forId === sel.id) set({ ai: null });
      notify(applied.synced ? 'Classement synchronisé avec le compte de messagerie.' : 'Classement enregistré dans Relay Desk.');
    } catch (e) { if (state.ai?.forId === sel.id) set({ ai: { ...state.ai, loading: false, error: e.message } }); }
  },
  aiInsert: () => {
    const id = state.ai?.forId, text = state.ai?.result?.text;
    if (id == null || !text || state.selectedId !== id || state.ai?.mode !== 'draft' || state.ai.loading) return;
    if (layers.at(-1) === 'ai') { layers.pop(); try { history.back?.(); } catch { /* sans historique */ } layers.push('__skip'); }
    set(s => ({ drafts: { ...s.drafts, [id]: text }, ai: null, composing: 'reply' }));
    scheduleAutosave(id);
  },

  // Contacts
  toggleContactSearch: () => set(s => ({ contactSearch: !s.contactSearch, contactQuery: s.contactSearch ? '' : s.contactQuery })),
  contactQuery: (_, e) => set({ contactQuery: e.target.value }),
  cycleSort: () => set(s => ({ sort: s.sort === 'recent' ? 'name' : 'recent' })),
  toggleAll: () => {
    const v = derive(state), all = v.contacts.length > 0 && v.picked.length === v.contacts.length;
    set({ picked: all ? {} : Object.fromEntries(v.contacts.map(c => [c.id, true])) });
  },
  pickContact: ({ id }) => set(s => ({ picked: { ...s.picked, [id]: !s.picked[id] } })),
  clearPicked: () => set({ picked: {} }),
  mailPicked: () => { const first = derive(state).picked[0]; set({ app: 'mail', query: first?.name || '', picked: {}, folder: null, nav: 'all' }); },
  focusContact: ({ id }) => set({ focusId: id }),
  cycleFreq: ({ id }) => {
    const c = state.data.contacts.find(x => x.id === id), before = c.freq;
    c.freq = (c.freq + 1) % 4;
    set({});
    api.updateContact(id, { freq: c.freq }).catch(err => { c.freq = before; fail(err); });
  },

  // Déconnexion d'un compte réel, depuis le menu du compte
  disconnectAccount: ({ id }) => {
    const acc = state.data.profiles.flatMap(p => p.accounts).find(a => a.id === Number(id));
    if (acc) set({ confirm: { kind: 'disconnect', accountId: acc.id, name: acc.name, busy: false, error: null }, menu: false, accountMenu: null });
  },
  confirmCancel: () => { if (state.confirm?.busy) return; if (layers.includes('confirm')) backFrom('confirm'); else set({ newMailOpen: !!state.confirm?.newMail, confirm: null }); },

  // Envoi : aperçu exact calculé par le serveur, puis envoi avec son empreinte.
  // Aperçu exact : le brouillon est d'abord enregistré, puis l'aperçu porte la version à jour (baseVersion) ;
  // un appareil dont le texte est dépassé ne peut ni fabriquer d'aperçu ni effacer un brouillon plus récent.
  sendPreview: async () => {
    const sel = derive(state).sel;
    if (!sel || state.confirm) return;
    const id = sel.id;
    clearTimeout(draftTimers.get(id));
    set({ confirm: { kind: 'send', messageId: id, input: null, preview: null, busy: true, error: null } });
    if (state.draftMeta[id]?.saving) await new Promise(r => { const t = setInterval(() => { if (!state.draftMeta[id]?.saving) { clearInterval(t); r(); } }, 50); });
    if (state.draftMeta[id]?.version !== undefined && draftText(id) !== state.draftMeta[id].savedText) await saveDraftNow(id);
    const meta = state.draftMeta[id] || {};
    if (meta.conflict || meta.error) { set({ confirm: null }); if (meta.error) fail(new Error(meta.error)); return; }
    const mode = state.composing || 'reply';
    const input = withBase({
      text: draftText(id),
      mode,
      to: mode === 'forward' ? (state.composeTo[id] ?? state.details[id]?.draft?.to ?? '') : null,
    }, meta.version);
    try {
      const preview = await api.previewSend(id, input);
      set({ confirm: { kind: 'send', messageId: id, input, preview, busy: false, error: null } });
      pushLayer('confirm');
    } catch (e) {
      set({ confirm: null });
      if (e.status === 409 && e.code === 'draft_conflict') setMeta(id, { conflict: true });
      else fail(e);
    }
  },
  confirmSend: async () => {
    const c = state.confirm;
    if (c?.kind !== 'send' || c.busy || !c.preview) return;
    set({ confirm: { ...c, busy: true, error: null } });
    let r;
    try {
      r = await api.send(c.messageId, { ...c.input, digest: c.preview.digest, ...(c.preview.approvalToken?{approvalToken:c.preview.approvalToken}:{}) });
    } catch (e) {
      // 409 : le contenu ou le fil a changé, il faut revérifier ; le bouton de confirmation est désactivé.
      // Une erreur Gmail incertaine (réseau, 5xx) consomme aussi la validation : vérifier à nouveau avant tout nouvel essai.
      set({ confirm: { ...c, busy: false, stale: !/^Erreur (Gmail|Outlook)/.test(e.message), error: e.message } });
      return;
    }
    // Envoi confirmé par le serveur : plus rien ici ne doit inviter à renvoyer.
    const id = c.messageId;
    compositionBuffers.delete(id);
    clearTimeout(draftTimers.get(id));
    if (layers.at(-1) === 'confirm') { layers.pop(); try { history.back?.(); } catch { /* sans historique */ } layers.push('__skip'); }
    // L'entrée d'historique du compositeur devient neutre : le retour suivant ne rouvre ni ne ferme rien d'autre.
    if (layers.includes('compose')) layers[layers.lastIndexOf('compose')] = '__skip';
    set(s => {
      const drafts = { ...s.drafts }, composeTo = { ...s.composeTo }, details = { ...s.details }, draftMeta = { ...s.draftMeta };
      delete drafts[id]; delete composeTo[id]; delete details[id]; delete draftMeta[id];
      return { confirm: null, composing: null, drafts, composeTo, details, draftMeta, ...(c.newMail ? { newMail: null, newMailOpen: false, selectedId: s.selectedId === id ? null : s.selectedId, data: { ...s.data, messages: s.data.messages.filter(m => m.id !== id) } } : {}) };
    });
    const m = state.data.messages.find(x => x.id === id);
    if (m) m.draft = null;
    const sent = r.draftRemoved === false ? 'Message envoyé. Le brouillon local est effacé ; son brouillon chez le fournisseur est conservé, supprime-le si besoin.' : 'Message envoyé.';
    notify(sent);
    try {
      await reload({ refresh: true });
    } catch {
      notify(`${sent} La liste sera actualisée au prochain passage.`);
    }
  },
  confirmDisconnect: async () => {
    const c = state.confirm;
    if (!c || c.busy) return;
    set({ confirm: { ...c, busy: true, error: null } });
    try {
      await api.disconnectAccount(c.accountId);
      selectionVersion++;
      for (const [id, draft] of compositionBuffers) if (draft.accountId === c.accountId) compositionBuffers.delete(id);
      if (state.newMail?.accountId === c.accountId) set({ newMail: null, newMailOpen: false });
      await reload({ refresh: true });
      const v = derive(state);
      set({ confirm: null, selectedId: v.sel ? state.selectedId : firstOf(state.profileId), folder: null });
    } catch (e) {
      set({ confirm: { ...c, busy: false, error: e.message } });
    }
  },

  // Assistant de connexion
  closeConnect: () => closeWizard(),
  pickService: ({ svc }) => { if (!state.data.services[svc].disabled) setC(svcInit(svc)); },
  cProfile: ({ id }) => setC({ profile: id }),
  cName: (_, e) => setC({ name: e.target.value }),
  cPerm: ({ perm }) => {
    const def = state.data.services[state.c.svc];
    if (def.available && !def.available.includes(perm)) return;
    setC(c => ({ perms: { ...c.perms, [perm]: !c.perms[perm] } }));
  },
  cWindow: ({ win }) => { const w = Number(win); if (WINDOWS.includes(w)) setC({ win: w }); },
  cField: ({ field }, e) => { const v = e.target.value; setC(c => ({ fields: { ...c.fields, [field]: v } })); },
  cBack: () => {
    const c = state.c;
    if (c.busy || c.linkId) return;
    setC({ step: c.step === 'auth' ? 'config' : 'pick', error: null });
  },
  refreshWhatsAppQR: async () => {
    const c = state.c;
    if (!c || c.busy) return;
    clearInterval(syncTimer);
    if (c.linkId) await api.cancelWhatsAppLink(c.linkId).catch(() => {});
    if (state.c?.wizardId !== c.wizardId || state.c?.linkId !== c.linkId) return;
    setC({ linkId: null, link: null, error: null }); startWhatsAppLink();
  },
  cNext: () => {
    const c = state.c;
    if (c.step === 'config') setC({ step: 'auth', error: null });
    else if (c.step === 'auth') c.svc === 'whatsapp' ? startWhatsAppLink() : state.data.services[c.svc].real ? startProviderAuth() : startSync();
    else if (c.step === 'done') { clearInterval(syncTimer); set({ c: null, app: 'mail', profileId: c.profile, selectedId: c.svc === 'whatsapp' ? state.data.messages.find(m => m.accountId === c.accountId && !m.archived)?.id ?? firstOf(c.profile) : c.profile === state.profileId ? state.selectedId : firstOf(c.profile), folder: null }); }
  },
};

delegate(document, {
  change: 'change', click: 'click', dblclick: 'dblclick', input: 'input', keydown: 'keydown', focusout: 'blur',
  dragstart: 'dragstart', dragover: 'dragover', dragleave: 'dragleave', drop: 'drop', pointerdown: 'pointerdown',
}, actions);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (state.confirm) actions.confirmCancel();
  else if (state.newMailOpen) actions.closeNewMail();
  else if (state.c) closeWizard();
  else if (state.ai) set({ ai: null });
  else if (state.menu || state.moveOpen || state.accountMenu) set({ menu: false, moveOpen: false, accountMenu: null });
});

// Navigateur seulement (absent des tests en machine virtuelle) : retour, format d'écran, clavier, réseau.
globalThis.addEventListener?.('popstate', onPopState);
const mobileQuery = globalThis.matchMedia?.('(max-width: 760px)');
mobileQuery?.addEventListener?.('change', e => { layers.length = 0; set({ mobile: e.matches, drawer: false, pane: e.matches && state.selectedId != null ? 'reader' : 'list' }); });
const viewport = globalThis.visualViewport;
if (viewport && document.documentElement) {
  // Hauteur visible réelle (clavier ouvert compris) pour garder le compositeur accessible.
  const fit = () => document.documentElement.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
  viewport.addEventListener('resize', fit);
  fit();
}
globalThis.addEventListener?.('offline', () => set({ offline: true }));
globalThis.addEventListener?.('online', () => { set({ offline: false }); if (state.data) reload({ refresh: true }).catch(() => {}); else if (state.loadError === 'offline') location.reload(); });
// Texte pas encore enregistré : le navigateur demande confirmation avant de quitter la page.
globalThis.addEventListener?.('beforeunload', e => {
  if (Object.keys(state.draftMeta).some(id => dirty(Number(id))) || state.newMail && !state.newMail.savedAt && state.newMail.text) { e.preventDefault(); e.returnValue = ''; }
});

api.session()
  .then(auth => { state.auth = auth; return api.state(listParams(state)); })
  .then(async data => {
    if (data.page) {
      const profileId = data.profiles.some(p => p.id === state.profileId) ? state.profileId : data.profiles[0]?.id;
      if (profileId !== state.profileId) { state.profileId = profileId; await reload(); }
      else applyData(data, { paged: true, counts: data.counts || null, page: { ...data.page, key: listKey(state), loading: false, error: null } });
      if (!state.mobile && state.selectedId == null) set({ selectedId: state.data.messages[0]?.id ?? null, selectedRow: state.data.messages[0] || null });
    } else {
      set({ data, selectedId: state.mobile ? null : data.messages.find(m => m.p === state.profileId && !m.archived)?.id ?? null });
    }
    resumeFromRedirect();
  })
  // Réseau absent (TypeError de fetch) : message hors ligne, jamais de redirection vers la connexion.
  .catch(err => {
    if (state.offline || err instanceof TypeError) set({ loadError: 'offline' });
    else if (!state.auth) location.replace('/login');
    else set({ loadError: err.message });
  });
render();
