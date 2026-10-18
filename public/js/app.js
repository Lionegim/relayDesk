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
  confirm: null,
  composeTo: {}, newMail: null, newMailOpen: false,
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
const compositionBuffers = new Map();
let selectionVersion = 0;
function rememberComposition() {
  if (state.newMail?.messageId) compositionBuffers.set(state.newMail.messageId, state.newMail);
}
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
  if (!state.data || state.c || !state.data.profiles.some(p => p.accounts.some(a => ['gmail', 'outlook'].includes(a.svc)))) return;
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
function startProviderAuth() {
  const c = state.c;
  if (!state.data.integrations?.[c.svc]?.configured) {
    setC({ error: `Connexion ${state.data.services[c.svc].name} non configurée : consulte sa documentation de connexion.` });
    return;
  }
  const perms = state.data.services[c.svc].available.filter(p => c.perms[p]);
  location.href = (c.svc === 'outlook' ? '/oauth/microsoft/start?' : '/oauth/google/start?') + new URLSearchParams({ profile: c.profile, name: c.name.trim(), win: c.win, perms: perms.join(','), ...(c.accountId ? { account: c.accountId } : {}) });
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
  const base = { svc: params.get('provider') || params.get('connect') || 'gmail', perms: { read: true }, fields: {}, progress: 0, fromAccount: false };
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

// Un même compositeur pour tous les comptes email pris en charge.
async function saveNewMail() {
  let c = state.newMail;
  if (!c || c.busy || !c.accountId) return null;
  set({ newMail: { ...c, busy: true, error: null } });
  try {
    if (!c.messageId) {
      const m = await api.createComposition(c.accountId);
      c = { ...c, messageId: m.id };
      set({ newMail: { ...c, busy: true } });
    }
    const input = { mode: 'new', to: c.to, cc: c.cc, subject: c.subject, text: c.text };
    const draft = await api.saveDraft(c.messageId, input);
    set({ newMail: { ...c, busy: false, savedAt: draft.savedAt, synced: draft.synced ?? draft.gmail, error: null } });
    try { applyData(await api.state()); } catch { /* l'enregistrement est déjà confirmé */ }
    return { c, input };
  } catch (e) {
    set({ newMail: { ...state.newMail, busy: false, error: e.message } });
    return null;
  }
}

// ---------- Actions ----------

const num = v => Number(v);
const firstOf = profileId => state.data.messages.find(m => m.p === profileId && !m.archived)?.id ?? null;

const actions = {
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
  selectProfile: ({ id }) => { selectionVersion++; rememberComposition(); set({ newMailOpen: false, profileId: id, menu: false, accountMenu: null, picked: {}, group: 'all', channel: 'all', query: '', selectedId: firstOf(id), folder: null, ai: null, moveOpen: false, creating: false, composing: null }); },
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
      set({ toast: 'Synchronisation demandée.' });
    } catch (e) { fail(e); }
  },
  openConnect: () => openWizard(),

  // Liste
  search: (_, e) => set({ query: e.target.value }),
  selectChannel: ({ id }) => set({ channel: id }),
  selectThread: async ({ id }) => {
    const version = ++selectionVersion, profileId = state.profileId;
    rememberComposition();
    const m = state.data.messages.find(x => x.id === num(id));
    set({ selectedId: m.id, moveOpen: false, composing: null });
    if (m.kind === 'new') {
      try {
        const cached = compositionBuffers.get(m.id);
        if (cached) { set({ newMailOpen: true, newMail: cached }); return; }
        const full = await api.message(m.id);
        if (selectionVersion !== version || state.profileId !== profileId || state.selectedId !== m.id) return;
        set({ newMailOpen: true, newMail: { messageId: full.id, accountId: full.accountId, to: full.draft?.to || '', cc: full.draft?.cc || '', subject: full.subject, text: full.draft?.text || '', savedAt: full.draft?.savedAt, synced: full.draft?.synced, busy: false } });
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
  compose: ({ mode }) => set({ composing: mode }),
  closeComposer: () => set({ composing: null }),
  composeTo: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ composeTo: { ...s.composeTo, [id]: v } })); },
  draft: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ drafts: { ...s.drafts, [id]: v } })); },
  saveDraft: () => {
    const sel = derive(state).sel;
    if (!sel) return;
    const text = state.drafts[sel.id] ?? state.details[sel.id]?.draft?.text ?? '';
    const mode = state.composing || 'reply';
    const to = mode === 'forward' ? (state.composeTo[sel.id] ?? state.details[sel.id]?.draft?.to ?? '') : null;
    api.saveDraft(sel.id, { text, mode, to }).then(draft => {
      sel.draft = { savedAt: draft.savedAt, gmail: draft.gmail, synced: draft.synced ?? draft.gmail };
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

  // Déconnexion d'un compte réel, depuis le menu du compte
  disconnectAccount: ({ id }) => {
    const acc = state.data.profiles.flatMap(p => p.accounts).find(a => a.id === Number(id));
    if (acc) set({ confirm: { kind: 'disconnect', accountId: acc.id, name: acc.name, busy: false, error: null }, menu: false, accountMenu: null });
  },
  confirmCancel: () => { if (!state.confirm?.busy) set({ newMailOpen: !!state.confirm?.newMail, confirm: null }); },

  // Envoi : aperçu exact calculé par le serveur, puis envoi avec son empreinte.
  sendPreview: async () => {
    const sel = derive(state).sel;
    if (!sel || state.confirm) return;
    const mode = state.composing || 'reply';
    const input = {
      text: state.drafts[sel.id] ?? state.details[sel.id]?.draft?.text ?? '',
      mode,
      to: mode === 'forward' ? (state.composeTo[sel.id] ?? state.details[sel.id]?.draft?.to ?? '') : null,
    };
    set({ confirm: { kind: 'send', messageId: sel.id, input, preview: null, busy: true, error: null } });
    try {
      const preview = await api.previewSend(sel.id, input);
      set({ confirm: { kind: 'send', messageId: sel.id, input, preview, busy: false, error: null } });
    } catch (e) {
      set({ confirm: null });
      fail(e);
    }
  },
  confirmSend: async () => {
    const c = state.confirm;
    if (c?.kind !== 'send' || c.busy || !c.preview) return;
    set({ confirm: { ...c, busy: true, error: null } });
    let r;
    try {
      r = await api.send(c.messageId, { ...c.input, digest: c.preview.digest });
    } catch (e) {
      // 409 : le contenu ou le fil a changé, il faut revérifier ; le bouton de confirmation est désactivé.
      // Une erreur Gmail incertaine (réseau, 5xx) consomme aussi la validation : vérifier à nouveau avant tout nouvel essai.
      set({ confirm: { ...c, busy: false, stale: !/^Erreur Gmail/.test(e.message), error: e.message } });
      return;
    }
    // Envoi confirmé par le serveur : plus rien ici ne doit inviter à renvoyer.
    const id = c.messageId;
    compositionBuffers.delete(id);
    set(s => {
      const drafts = { ...s.drafts }, composeTo = { ...s.composeTo }, details = { ...s.details };
      delete drafts[id]; delete composeTo[id]; delete details[id];
      return { confirm: null, composing: null, drafts, composeTo, details, ...(c.newMail ? { newMail: null, newMailOpen: false } : {}) };
    });
    const m = state.data.messages.find(x => x.id === id);
    if (m) m.draft = null;
    const sent = r.draftRemoved === false ? 'Message envoyé. Le brouillon local est effacé ; son brouillon chez le fournisseur est conservé, supprime-le si besoin.' : 'Message envoyé.';
    notify(sent);
    try {
      applyData(await api.state());
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
      applyData(await api.state());
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
  cBack: () => setC(c => ({ step: c.step === 'auth' ? 'config' : 'pick', error: null })),
  cNext: () => {
    const c = state.c;
    if (c.step === 'config') setC({ step: 'auth', error: null });
    else if (c.step === 'auth') state.data.services[c.svc].real ? startProviderAuth() : startSync();
    else if (c.step === 'done') { clearInterval(syncTimer); set({ c: null, app: 'mail', profileId: c.profile, selectedId: c.profile === state.profileId ? state.selectedId : firstOf(c.profile), folder: null }); }
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

api.state()
  .then(data => {
    set({ data, selectedId: data.messages.find(m => m.p === state.profileId && !m.archived)?.id ?? null });
    resumeFromRedirect();
  })
  .catch(err => { set({ loadError: err.message }); });
render();
