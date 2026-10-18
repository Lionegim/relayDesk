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
};

const root = document.getElementById('root');
let scheduled = false;
function set(next) {
  Object.assign(state, typeof next === 'function' ? next(state) : next);
  if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; render(); }); }
}
function render() {
  if (!state.data) {
    patch(root, `<div class="loading">${state.loadError ? 'Impossible de charger les données.' : 'Chargement…'}</div>`);
    return;
  }
  const v = derive(state);
  if (v.sel) loadDetails(v.sel.id);
  patch(root, renderApp(state, v));
}

// Corps et fil sont chargés à la demande : l'état global ne contient que la liste.
const loading = new Set();
function loadDetails(id) {
  if (state.details[id] || loading.has(id)) return;
  loading.add(id);
  api.message(id)
    .then(full => set(s => ({ details: { ...s.details, [id]: full } })))
    .catch(err => { set(s => ({ details: { ...s.details, [id]: { failed: true, trail: [] } } })); fail(err); })
    .finally(() => loading.delete(id));
}

// Rafraîchit la liste quand un compte réel est synchronisé en arrière-plan.
const REFRESH_MS = 30000;
setInterval(async () => {
  if (!state.data || state.c || !state.data.profiles.some(p => p.accounts.some(a => a.svc === 'gmail'))) return;
  try { applyData(await api.state()); } catch { /* nouvel essai au prochain passage */ }
}, REFRESH_MS);

function applyData(data) {
  const before = new Map((state.data?.messages || []).map(m => [m.id, m.sortAt + ':' + m.count]));
  const details = Object.fromEntries(Object.entries(state.details).filter(([id]) => {
    const m = data.messages.find(x => x.id === Number(id));
    return m && before.get(m.id) === m.sortAt + ':' + m.count;
  }));
  set({ data, details });
}

let toastTimer;
function fail(err) {
  clearTimeout(toastTimer);
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
  const profile = d.profiles.find(p => p.id === s.profileId);
  const inProfile = d.messages.filter(m => m.p === s.profileId && !m.archived);
  const byNav = s.folder
    ? inProfile.filter(m => folderSet(s.folder).has(m.folderId))
    : inProfile.filter(m => s.nav === 'all' || (s.nav === 'unread' && m.unread) || (s.nav === 'todo' && m.flagged) || (s.nav === 'drafts' && m.draft));
  const q = s.query.trim().toLowerCase();
  const list = byNav.filter(m => (s.channel === 'all' || m.channel === s.channel) && (!q || (m.from + m.subject + m.preview).toLowerCase().includes(q)));
  const sel = inProfile.find(m => m.id === s.selectedId) || null;

  const contactsMine = d.contacts.filter(c => c.p === s.profileId);
  const cq = s.contactQuery.trim().toLowerCase();
  const contacts = contactsMine
    .filter(c => (s.group === 'all' || c.g.includes(s.group)) && (!cq || (c.name + c.title).toLowerCase().includes(cq)))
    .sort(s.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.order - b.order);

  return {
    profile, inProfile, byNav, list, sel, contactsMine, contacts,
    picked: contacts.filter(c => s.picked[c.id]),
    folders: flatFolders(s),
    folderCount: id => { const set = folderSet(id); return inProfile.filter(m => set.has(m.folderId)).length; },
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

async function aiRun() {
  const s = state, sel = derive(s).sel;
  if (!s.ai || !sel) return;
  const mode = s.ai.mode, forId = sel.id;
  set({ ai: { ...s.ai, loading: true, result: null, error: null, forId } });
  let result = null, error = null;
  try {
    result = (mode === 'summary' ? await api.summarize(forId) : await api.draftReply(forId, s.aiTone, s.aiIntent)).text;
  } catch (e) {
    error = e.message;
  }
  if (state.ai && state.ai.forId === forId && state.ai.mode === mode) set({ ai: { ...state.ai, loading: false, result, error } });
}

function aiOpen(mode) {
  const sel = derive(state).sel;
  if (!sel) return;
  set({ ai: { mode, result: null, error: null, loading: false, forId: sel.id }, moveOpen: false });
  if (mode === 'summary') aiRun();
}

// ---------- Assistant de connexion ----------

let syncTimer;
function svcInit(key, name) {
  const def = state.data.services[key], fields = {};
  (def.fields || []).forEach(f => { fields[f[0]] = f[2]; });
  return { step: 'config', svc: key, name: name || def.name, fields, perms: { read: true } };
}
function openWizard(svc, name, account = null) {
  const c = { step: 'pick', svc: null, profile: state.profileId, name: '', perms: { read: true }, win: 30, fields: {}, progress: 0, fromAccount: !!name };
  if (svc) Object.assign(c, svcInit(svc, name));
  if (account) Object.assign(c, { accountId: account.id, win: account.windowDays || 30, perms: Object.fromEntries(['read', ...(account.perms || [])].map(p => [p, true])) });
  set({ c, menu: false, accountMenu: null });
}
const setC = f => set(s => ({ c: { ...s.c, ...(typeof f === 'function' ? f(s.c) : f) } }));
function closeWizard() { clearInterval(syncTimer); set({ c: null }); }

// Gmail : autorisation réelle dans Google (pleine page), puis suivi de l'import côté serveur.
function startGoogleAuth() {
  const c = state.c;
  if (!state.data.integrations?.gmail?.configured) {
    setC({ error: 'Connexion Gmail non configurée : renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env, puis redémarre Relay.' });
    return;
  }
  const perms = state.data.services.gmail.available.filter(p => c.perms[p]);
  location.href = '/oauth/google/start?' + new URLSearchParams({ profile: c.profile, name: c.name.trim(), win: c.win, perms: perms.join(','), ...(c.accountId ? { account: c.accountId } : {}) });
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
      applyData(await api.state());
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
  const base = { svc: 'gmail', perms: { read: true }, fields: {}, progress: 0, fromAccount: false };
  if (params.has('connect_error')) {
    set({ c: { ...base, step: 'auth', profile: state.profileId, name: 'Gmail', win: 30, error: params.get('connect_error') } });
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

// ---------- Actions ----------

const num = v => Number(v);
const firstOf = profileId => state.data.messages.find(m => m.p === profileId && !m.archived)?.id ?? null;

const actions = {
  noop: () => {},
  toggleProfileMenu: () => set({ menu: !state.menu, accountMenu: null }),
  selectProfile: ({ id }) => set({ profileId: id, menu: false, accountMenu: null, picked: {}, group: 'all', channel: 'all', query: '', selectedId: firstOf(id), folder: null, ai: null, moveOpen: false, creating: false, composing: null }),
  selectApp: ({ app }) => set({ app, ai: null, moveOpen: false }),
  selectNav: ({ id }) => set({ nav: id, channel: 'all', folder: null }),
  selectGroup: ({ id }) => set({ group: id, app: 'contacts' }),

  // Dossiers
  newRootFolder: () => set({ creating: 'root', folderDraft: '' }),
  addSubfolder: ({ id }, e) => { e.stopPropagation(); set(s => ({ creating: id, folderDraft: '', collapsed: { ...s.collapsed, [id]: false } })); },
  toggleFolder: ({ id }, e) => { e.stopPropagation(); set(s => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })); },
  selectFolder: ({ id }) => set({ folder: id, channel: 'all' }),
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
    if (acc?.svc === 'gmail') return set({ accountMenu: state.accountMenu === acc.id ? null : acc.id, menu: false });
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
      set({ toast: 'Synchronisation Gmail demandée.' });
    } catch (e) { fail(e); }
  },
  openConnect: () => openWizard(),

  // Liste
  search: (_, e) => set({ query: e.target.value }),
  selectChannel: ({ id }) => set({ channel: id }),
  selectThread: ({ id }) => {
    const m = state.data.messages.find(x => x.id === num(id));
    set({ selectedId: m.id, moveOpen: false, composing: null });
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
  compose: ({ mode }) => set({ composing: mode }),
  closeComposer: () => set({ composing: null }),
  draft: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ drafts: { ...s.drafts, [id]: v } })); },
  saveDraft: () => {
    const sel = derive(state).sel;
    if (!sel) return;
    const text = state.drafts[sel.id] ?? state.details[sel.id]?.draft?.text ?? '';
    api.saveDraft(sel.id, text).then(draft => {
      sel.draft = { savedAt: draft.savedAt };
      if (state.details[sel.id]) state.details[sel.id].draft = draft;
      set({});
    }).catch(fail);
  },
  toggleFlag: () => { const sel = derive(state).sel; if (sel) patchMessage(sel.id, { flagged: !sel.flagged }); },
  toggleRead: () => { const sel = derive(state).sel; if (sel) patchMessage(sel.id, { unread: !sel.unread }); },
  archive: () => {
    const v = derive(state);
    if (!v.sel) return;
    const next = v.list.find(m => m.id !== v.sel.id);
    patchMessage(v.sel.id, { archived: true });
    set({ selectedId: next?.id ?? null, composing: null });
  },
  toggleTrail: ({ trail }) => set(s => ({ expandedTrail: { ...s.expandedTrail, [trail]: !s.expandedTrail[trail] } })),

  // Assistant IA
  aiSummary: () => aiOpen('summary'),
  aiDraft: () => aiOpen('draft'),
  aiTab: ({ mode }) => { if (state.ai?.mode !== mode) aiOpen(mode); },
  aiClose: () => set({ ai: null }),
  aiTone: ({ tone }) => set({ aiTone: tone }),
  aiIntent: (_, e) => set({ aiIntent: e.target.value }),
  aiRun: () => aiRun(),
  aiInsert: () => {
    const id = state.ai?.forId, text = state.ai?.result;
    if (id == null || !text) return;
    set(s => ({ drafts: { ...s.drafts, [id]: text }, ai: null, composing: s.composing || 'reply' }));
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
  cBack: () => setC(c => ({ step: c.step === 'auth' ? 'config' : 'pick', error: null })),
  cNext: () => {
    const c = state.c;
    if (c.step === 'config') setC({ step: 'auth', error: null });
    else if (c.step === 'auth') state.data.services[c.svc].real ? startGoogleAuth() : startSync();
    else if (c.step === 'done') { clearInterval(syncTimer); set({ c: null, app: 'mail', profileId: c.profile, selectedId: c.profile === state.profileId ? state.selectedId : firstOf(c.profile), folder: null }); }
  },
};

delegate(document, {
  click: 'click', dblclick: 'dblclick', input: 'input', keydown: 'keydown', focusout: 'blur',
  dragstart: 'dragstart', dragover: 'dragover', dragleave: 'dragleave', drop: 'drop', pointerdown: 'pointerdown',
}, actions);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (state.c) closeWizard();
  else if (state.ai) set({ ai: null });
  else if (state.menu || state.moveOpen || state.accountMenu) set({ menu: false, moveOpen: false, accountMenu: null });
});

api.state()
  .then(data => {
    set({ data, selectedId: data.messages.find(m => m.p === state.profileId && !m.archived)?.id ?? null });
    resumeFromRedirect();
  })
  .catch(err => { set({ loadError: err.message }); });
render();
