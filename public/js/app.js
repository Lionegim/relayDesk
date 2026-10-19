import { api } from './api.js';
import { patch, delegate } from './dom.js';
import { renderApp } from './views.js';
import { NAV, GROUPS, SETTINGS, WINDOWS } from './constants.js';
import { createLiveUpdates, ARCHIVE_REFRESH_MS } from './live.js';

const LIST_W_KEY = 'relay.listW';
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* stockage indisponible */ } },
};

const state = {
  data: null, loadError: null, toast: null,
  app: 'mail', profileId: storage.get('relay.profile') || null, menu: false, accountMenu: null,
  nav: 'all', folder: null, channel: 'all', query: '', selectedId: null,
  collapsed: (()=>{try{return JSON.parse(storage.get('relay.folderExpansion') || '{}');}catch{return {};}})(), creating: false, folderDraft: '', dragOver: null, moveOpen: false,
  listW: Number(storage.get(LIST_W_KEY)) || 340, resizing: false,
  composing: null, drafts: {}, expandedTrail: {}, waAttachments:{}, waUploading:null, waEmoji:false, waMessageMenu:null, waReacting:null, waParticipants:{},waParticipantsBusy:null,waParticipantsError:{},waMention:null,
  ai: null, aiTone: 'Cordial', aiIntent: '',
  contactView:globalThis.matchMedia?.('(max-width:600px)').matches?'list':'network',network:null,networkBusy:false,networkError:null,networkDays:90,groupEditor:null,groupName:'',groupQuery:'',groupBusy:false,
  group: 'all', picked: {}, focusId: null, contactQuery: '', contactSearch: false, sort: 'recent',
  contactHistory:null,contactHistoryError:null,historyBusy:false,
  duplicates:null,duplicatesBusy:false,duplicatesError:null,duplicatesReview:null,duplicatesKeep:null,duplicatesTab:'pending',duplicatesLimit:25,
  personOpen:null, person:null, personError:null, personBusy:false, personKind:'email', personValue:'',personAddOpen:false, personMerge:'', contactImport:false, contactImportBusy:null, fromPerson:false,
  mailSettings:{},mailSettingsDays:{},mailSettingsPreview:null,mailSettingsBusy:null,mailSettingsError:null,
  mailText:{},
  c: null,
  details: {},
  confirm: null, auth: null, authPanel: null,
  composeTo: {}, newMail: null, newMailOpen: false,
  // Liste paginée côté serveur (paged=true) ; sinon instantané complet de l'ancien serveur.
  paged: false, page: null, counts: null, selectedRow: null, historyLoading: {},
  // Brouillons : version serveur, texte enregistré, état d'enregistrement et conflit, par message.
  draftMeta: {},
  // Mobile (<= 1000 px, téléphones en paysage et tablettes en portrait) : un seul écran à la fois, tiroir pour la barre latérale.
  mobile: !!globalThis.matchMedia?.('(max-width: 1000px)').matches, pane: 'list', drawer: false,
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
  if (state.app==='mail' && v.sel) {loadDetails(v.sel.id);const full=state.details[v.sel.id];if(full && !full.failed && full.channel==='email' && full.kind!=='new' && !full.displayStatus)loadMailDisplay(v.sel.id,full);}
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
const detailJobs = new Map(), detailRevisions = new Map();
const compositionBuffers = new Map();
const compositionsByCid=new Map();
let selectionVersion = 0, previewRequest = 0;
function rememberComposition() {
  const c=state.newMail;
  if(c?.cid!=null) compositionsByCid.set(c.cid,c);
  if(c?.messageId) compositionBuffers.set(c.messageId,c);
}
// Chaque nouveau message a une identité locale (cid) : un retour réseau ne s'applique qu'à sa propre composition.
let compositionSeq = 0;
const EMPTY_MAIL = { to: '', cc: '', subject: '', text: '' };
const mailFields = c => ({ to: c.to, cc: c.cc, subject: c.subject, text: c.text });
const newComposition = fields => ({ ...EMPTY_MAIL, saved: EMPTY_MAIL, busy: false, saving: false, ...fields, cid: ++compositionSeq });
const mailChanged = c => !!c && (c.aiAssisted && !c.aiPersisted || ['to', 'cc', 'subject', 'text'].some(k => c[k] !== (c.saved || EMPTY_MAIL)[k]));
let prependAnchor = null;
const known = id => state.data.messages.some(m => m.id === id) || (state.selectedRow?.id === id && state.selectedId === id);
// Identité d'un élément du fil, pour fusionner des pages sans doublon.
const trailKey = t => t.id != null ? `id:${t.id}` : `${t.at}|${t.fromMe}|${t.from}|${t.body}`;
const oldestAt = full => Math.min(...(full.trail || []).map(t => Number.isFinite(t.at) ? t.at : Infinity), Number.isFinite(full.at) ? full.at : Infinity);
// Une actualisation ne recharge que la page récente : l'historique plus ancien déjà affiché est conservé.
function mergeHistory(prev, next) {
  if (!prev || prev.failed || !prev.trail?.length || prev.historyWindowRevision!==next.historyWindowRevision) return next;
  const seen = new Set((next.trail || []).map(trailKey)), limit = oldestAt(next);
  const extra = prev.trail.filter(t => !seen.has(trailKey(t)) && Number.isFinite(t.at) && t.at <= limit);
  return extra.length ? { ...next, trail: [...(next.trail || []), ...extra], history: prev.history ?? next.history } : next;
}
function loadMailDisplay(id,full){
 const revision=detailRevisions.get(id)||0;
 set(s=>({details:{...s.details,[id]:{...full,displayStatus:'loading'}}}));
 api.mailDisplay(id).then(display=>{const current=state.details[id];if(current && current.sortAt===full.sortAt && current.count===full.count && revision===(detailRevisions.get(id)||0))set(s=>({details:{...s.details,[id]:{...current,display,displayStatus:'ready'}}}));}).catch(()=>{const current=state.details[id];if(current && current.sortAt===full.sortAt && current.count===full.count && revision===(detailRevisions.get(id)||0))set(s=>({details:{...s.details,[id]:{...current,displayStatus:'failed'}}}));});
}
function loadDetails(id) {
  if (loading.has(id)) return detailJobs.get(id);
  if (state.details[id] && !state.details[id].refreshing) return true;
  loading.add(id);
  const revision = detailRevisions.get(id) || 0;
  const job = api.message(id)
    .then(async full => {
      const sourceMatches=()=>{const row=state.data.messages.find(m=>m.id===id) || (state.selectedRow?.id===id?state.selectedRow:null);return !row?.conversationIdentity || row.conversationIdentity===full.conversationIdentity;};
      if(!known(id) || revision!==(detailRevisions.get(id)||0) || !sourceMatches())return true;
      // Refresh interactions on older pages already on screen without downloading their bodies again.
      const old=state.details[id];
      if(full.channel==='whatsapp' && old?.trail?.length && api.whatsAppInteractions) {
        const ids=old.trail.map(t=>t.waId).filter(id=>id && !(full.trail||[]).some(t=>t.waId===id));
        const updates=[];
        for(let i=0;i<ids.length;i+=200)updates.push(...await api.whatsAppInteractions(id,ids.slice(i,i+200)));
        const byId=new Map(updates.map(m=>[m.waId,m]));
        if(known(id) && revision===(detailRevisions.get(id)||0) && state.details[id]===old)state.details={...state.details,[id]:{...old,trail:old.trail.filter(t=>!byId.get(t.waId)?.unavailable).map(t=>({...t,...byId.get(t.waId)}))}};
      }
      if (!known(id) || revision !== (detailRevisions.get(id) || 0) || !sourceMatches()) return true;
      const merged = mergeHistory(state.details[id], full);
      syncDraftMeta(id, merged);
      set(s => ({ details: { ...s.details, [id]: merged } }));
      return true;
    })
    .catch(err => {
      if (!known(id) || revision !== (detailRevisions.get(id) || 0)) return true;
      if(err.status===404){set(s=>({details:Object.fromEntries(Object.entries(s.details).filter(([key])=>Number(key)!==id)),...(s.selectedId===id?{selectedId:null,selectedRow:null}: {})}));return false;}
      set(s => ({ details: { ...s.details, [id]: s.details[id] && !s.details[id].failed
        ? { ...s.details[id], refreshing: false, stale: true } : { failed: true, trail: [] } } }));
      fail(err);
      return false;
    })
    .finally(() => { loading.delete(id); detailJobs.delete(id); })
    .then(ok => revision !== (detailRevisions.get(id) || 0) && known(id) ? loadDetails(id) : ok);
  detailJobs.set(id, job);
  return job;
}

// Rafraîchit la liste quand un compte réel est synchronisé en arrière-plan.
const REFRESH_MS = 30000;
let liveUpdates = null;
setInterval(async () => {
  if (liveUpdates?.connected || !state.data || state.c || state.confirm || state.offline || !state.data.profiles.some(p => p.accounts.some(a => ['gmail', 'outlook', 'whatsapp'].includes(a.svc)))) return;
  try { await reload({ refresh: true }); } catch { /* nouvel essai au prochain passage */ }
}, REFRESH_MS);
setInterval(async () => {
  if (liveUpdates?.connected || !state.data || state.c || state.confirm || state.offline || !state.data.profiles.some(p => p.accounts.some(a => a.svc === 'whatsapp' && a.sync?.status === 'syncing'))) return;
  try { await reload({ refresh: true }); } catch { /* progression au prochain passage */ }
}, 3000);

function withUnified(data) {
 if(!data.unifiedProfile)return data;
 const accounts=data.profiles.filter(p=>p.id!=='all').flatMap(p=>p.accounts.map(a=>({...a,profileId:p.id,profileName:p.name})));
 return {...data,profiles:[...data.profiles.filter(p=>p.id!=='all'),{...data.unifiedProfile,accounts}]};
}
let historyRequest=0;
async function loadContactHistory(){const profile=state.profileId,request=++historyRequest;try{const result=await api.contactHistory(profile);if(state.profileId===profile && request===historyRequest)set({contactHistory:result,contactHistoryError:null});}catch(e){if(state.profileId===profile && request===historyRequest)set({contactHistoryError:e.message});}}

let duplicatesRequest=0,duplicateActionVersion=0;
let settingsRequest=0;
async function loadMailSettings(){
 const version=++settingsRequest;set({mailSettingsError:null});
 const accounts=state.data.profiles.filter(p=>p.id!=='all').flatMap(p=>p.accounts).filter(a=>['gmail','outlook'].includes(a.svc));
 try{const results=await Promise.all(accounts.map(a=>api.historyWindow(a.id)));if(version===settingsRequest)set({mailSettings:Object.fromEntries(results.map(r=>[r.accountId,r])),mailSettingsDays:Object.fromEntries(results.map(r=>[r.accountId,r.days]))});}catch(e){if(version===settingsRequest)set({mailSettingsError:e.message});}
}
let networkRequest=0;
async function loadNetwork(){
 const request=++networkRequest,profile=state.profileId,days=state.networkDays;set({networkBusy:true,networkError:null});
 try{const network=await api.network(profile,days);if(request===networkRequest && profile===state.profileId)set({network});}catch(e){if(request===networkRequest)set({networkError:e.message});}finally{if(request===networkRequest)set({networkBusy:false});}
}
async function loadDuplicates(scan=false) {
 const profile=state.profileId,request=++duplicatesRequest;
 try{const result=await (scan?api.scanDuplicates(profile):api.duplicates(profile));if(state.profileId===profile && request===duplicatesRequest)set({duplicates:result,duplicatesError:null});}
 catch(e){if(state.profileId===profile && request===duplicatesRequest)set({duplicatesError:e.message});}
}
async function actOnDuplicate(fn) {
 const profile=state.profileId;if(state.duplicatesBusy || state.offline)return;const version=++duplicateActionVersion;set({duplicatesBusy:true,duplicatesError:null});
 try{await fn(profile);if(state.profileId!==profile || version!==duplicateActionVersion)return;set({duplicatesReview:null,duplicatesKeep:null});await reload({refresh:true});if(state.profileId===profile && version===duplicateActionVersion)await loadDuplicates(true);}
 catch(e){if(state.profileId===profile && version===duplicateActionVersion)set({duplicatesError:e.message});}
 finally{if(state.profileId===profile && version===duplicateActionVersion)set({duplicatesBusy:false});}
}

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
    data = withUnified(await api.state(listParams(state, { limit, cursor })));
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
  data=withUnified(data);
  // Empreinte d'une ligne : dernier message, nombre et version du brouillon (modifié sur un autre appareil).
  const mark = m => `${m.sortAt}:${m.count}:${m.conversationIdentity ?? ''}:${m.interactionVersion ?? 0}:${m.draftVersion ?? ''}`;
  const previousAccounts=new Map((state.data?.profiles || []).filter(p=>p.id!=='all').flatMap(p=>p.accounts).map(a=>[a.id,a.historyWindowRevision]));
  const changedWindows=new Set(data.profiles.filter(p=>p.id!=='all').flatMap(p=>p.accounts).filter(a=>previousAccounts.has(a.id) && previousAccounts.get(a.id)!==a.historyWindowRevision).map(a=>a.id));
  const priorRows=new Map((state.data?.messages || []).map(m=>[m.id,m]));
  for(const row of data.messages)if(priorRows.has(row.id) && priorRows.get(row.id).conversationIdentity!==row.conversationIdentity)detailRevisions.set(row.id,(detailRevisions.get(row.id)||0)+1);
  const before = new Map((state.data?.messages || []).map(m => [m.id, mark(m)]));
  const details = Object.fromEntries(Object.entries(state.details).flatMap(([id, full]) => {
    const m = data.messages.find(x => x.id === Number(id)) || (Number(id) === state.selectedId && state.selectedRow?.id === state.selectedId ? state.selectedRow : null);
    if (!m || (full.conversationIdentity && full.conversationIdentity!==m.conversationIdentity)) return [];
    if(changedWindows.has(m.accountId)){detailRevisions.set(m.id,(detailRevisions.get(m.id)||0)+1);return [];}
    if (!full.stale && before.get(m.id) === mark(m)) return [[id, full]];
    // Garder les bulles pendant le rechargement préserve l'ancrage de lecture.
    return m.channel === 'whatsapp' && !full.failed ? [[id, { ...full, refreshing: true }]] : [];
  }));
  const a = state.ai, updated = a && (data.messages.find(m => m.id === a.forId) || (state.selectedRow?.id === a.forId ? state.selectedRow : null));
  const ai = a && (!updated || changedWindows.has(updated.accountId) || (before.has(updated.id) && before.get(updated.id).split(':').slice(0,2).join(':') !== `${updated.sortAt}:${updated.count}`)) ? null : a;
  // La ligne sélectionnée reste connue même hors de la page affichée (même profil).
  const row = data.messages.find(m => m.id === state.selectedId);
  const waParticipants=Object.fromEntries(Object.entries(state.waParticipants).filter(([id,c])=>{const row=data.messages.find(m=>m.id===Number(id)) || (state.selectedRow?.id===Number(id)?state.selectedRow:null);return row?.conversationIdentity===c.conversationIdentity && details[id]?.participantScope===c.scope;}));
  set({ data, details, ai,waParticipants, ...(row ? { selectedRow: row } : {}), ...(changedWindows.size && state.personOpen?{person:null}:{}), ...extra });
  if(changedWindows.size && state.personOpen){const id=state.personOpen,profile=state.profileId,versions=JSON.stringify(data.profiles.flatMap(p=>p.accounts).map(a=>[a.id,a.historyWindowRevision]));api.person(profile,id).then(person=>{if(state.personOpen===id && state.profileId===profile && versions===JSON.stringify(state.data.profiles.flatMap(p=>p.accounts).map(a=>[a.id,a.historyWindowRevision])))set({person});}).catch(()=>{});}

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
const setMeta = (id, patch) => set(s => ({ draftMeta: { ...s.draftMeta, [id]: { ...s.draftMeta[id], ...patch } } }));
// Ce qu'un brouillon enregistre : texte, mode et destinataire d'un transfert. Changer seulement le mode
// (transférer, répondre à tous) ou le destinataire est une modification à enregistrer comme le texte.
function serverDraft(full) {
  const mode = full?.draft?.mode || 'reply';
  return { ...(full?.channel==='whatsapp'?{replyTo:full?.draft?.replyTo ?? null,mentions:full?.draft?.mentions || []}:{}),text: full?.draft?.text ?? '', mode, to: mode === 'forward' ? (full?.draft?.to ?? '') : null };
}
// Référence : dernier état enregistré connu (pas le détail rechargé, qui peut venir d'un autre appareil).
const savedDraft = id => state.draftMeta[id]?.saved || serverDraft(state.details[id]);
const draftText = id => state.drafts[id] ?? savedDraft(id).text;
function localDraft(id) {
  const base=savedDraft(id),mode=state.draftMeta[id]?.localMode ?? ((state.selectedId===id && state.composing) || base.mode);
  return { ...(state.details[id]?.channel==='whatsapp'?{replyTo:state.draftMeta[id]?.localReplyTo !== undefined?state.draftMeta[id].localReplyTo:base.replyTo ?? null,mentions:state.draftMeta[id]?.localMentions ?? base.mentions ?? []}:{}),text: draftText(id), mode, to: mode === 'forward' ? (state.composeTo[id] ?? base.to ?? '') : null };
}
const sameDraft = (a, b) => !!a && !!b && a.text === b.text && a.mode === b.mode && a.to === b.to && (a.replyTo ?? null)===(b.replyTo ?? null) && JSON.stringify((a.mentions||[]).map(m=>[m.jid,m.start,m.end]))===JSON.stringify((b.mentions||[]).map(m=>[m.jid,m.start,m.end]));
const changed = id => !!state.draftMeta[id] && !sameDraft(localDraft(id), savedDraft(id));
const dirty = id => { const m = state.draftMeta[id]; return !!m && (m.saving || m.conflict || changed(id)); };

// Version reçue du serveur. Si elle change alors que le brouillon local n'est pas enregistré : conflit, jamais d'écrasement.
function syncDraftMeta(id, full) {
  if (full.failed) return;
  const meta = state.draftMeta[id], version = versionOf(full), saved = serverDraft(full);
  if (!meta || meta.version === undefined) { state.draftMeta = { ...state.draftMeta, [id]: { ...meta, version, saved, savedText: saved.text, savedAt: full.draft?.savedAt } }; return; }
  if (meta.saving || version === meta.version) return;
  if (changed(id)) {
    state.draftMeta = { ...state.draftMeta, [id]: { ...meta, conflict: true } };
    return;
  }
  // Brouillon local propre : la version du serveur est reprise.
  const drafts = { ...state.drafts }, composeTo = { ...state.composeTo };
  delete drafts[id]; delete composeTo[id];
  state.drafts = drafts; state.composeTo = composeTo;
  if(state.selectedId===id && state.composing) state.composing=saved.mode;
  state.draftMeta = { ...state.draftMeta, [id]: { ...meta, version, saved, localMode:undefined,localReplyTo:undefined,localMentions:undefined, savedText: saved.text, savedAt: full.draft?.savedAt, conflict: false, error: null } };
}

// Mention ranges are UTF-16 textarea offsets. Any edit touching a token removes its binding.
function mentionEdits(oldText,text,mentions=[]) {
 let start=0;while(start<oldText.length && start<text.length && oldText[start]===text[start])start++;
 let oldEnd=oldText.length,end=text.length;while(oldEnd>start && end>start && oldText[oldEnd-1]===text[end-1]){oldEnd--;end--;}
 const delta=end-oldEnd;
 return mentions.flatMap(m=>m.end<=start?[m]:m.start>=oldEnd?[{...m,start:m.start+delta,end:m.end+delta}]:[]).filter(m=>text.slice(m.start,m.end)==='@'+m.jid.split('@')[0] && !/[\p{L}\p{N}_@]/u.test(text[m.start-1] || '') && !/[\p{L}\p{N}_]/u.test(text[m.end] || ''));
}
const mentionSearch=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function mentionOptions() {
 const q=state.waMention;if(!q || q.id!==state.selectedId || state.waParticipantsBusy===q.id || state.waParticipantsError[q.id])return [];
 const query=mentionSearch(q.query);
 const cache=state.waParticipants[q.id];
 return (cache?.scope===state.details[q.id]?.participantScope?cache?.members || []:[]).filter(p=>mentionSearch(p.name+' '+(p.phone||'')+' '+p.token).includes(query)).slice(0,6);
}
let mentionLookupSeq=0;const mentionLookups=new Map();
async function loadMentionParticipants(id,force=false) {
 if(state.offline || state.waParticipantsBusy===id || (!force && state.waParticipants[id]?.scope===state.details[id]?.participantScope && state.waParticipants[id]?.loadedAt>Date.now()-60000))return;
 const account=state.details[id]?.accountId,scope=state.details[id]?.participantScope,conversationIdentity=state.details[id]?.conversationIdentity,request=++mentionLookupSeq;mentionLookups.set(id,request);
 set(s=>({waParticipantsBusy:id,waParticipantsError:{...s.waParticipantsError,[id]:null}}));
 try{const result=await api.whatsAppParticipants(id);if(known(id) && mentionLookups.get(id)===request && state.details[id]?.accountId===account && state.details[id]?.participantScope===scope && result.scope===scope)set(s=>({waParticipants:{...s.waParticipants,[id]:{scope,conversationIdentity,members:result.members,loadedAt:Date.now()}}}));}
 catch(e){if(known(id) && state.details[id]?.participantScope===scope && mentionLookups.get(id)===request)set(s=>({waParticipantsError:{...s.waParticipantsError,[id]:e.message}}));}
 finally{if(state.waParticipantsBusy===id && mentionLookups.get(id)===request)set({waParticipantsBusy:null});}
}
function updateMentionQuery(el) {
 const id=state.selectedId,text=el.value,caret=el.selectionStart ?? text.length;
 if(!state.details[id]?.group || state.confirm || el.selectionEnd!==caret){set({waMention:null});return;}
 const match=/(?:^|[\s(])@([^\s@]{0,50})$/.exec(text.slice(0,caret));
 if(!match){if(state.waMention)set({waMention:null});return;}
 const from=caret-match[1].length-1;
 if(localDraft(id).mentions?.some(m=>from>=m.start && from<m.end)){set({waMention:null});return;}
 set({waMention:{id,from,to:caret,query:match[1],active:0}});loadMentionParticipants(id);
}
function updateDraftText(id,text) {
 const old=localDraft(id);
 if(state.details[id]?.channel==='whatsapp')setMeta(id,{localMentions:mentionEdits(old.text,text,old.mentions)});
 set(s=>({drafts:{...s.drafts,[id]:text}}));scheduleAutosave(id);
}
function scheduleAutosave(id) {
  clearTimeout(draftTimers.get(id));
  draftTimers.set(id, setTimeout(() => { draftTimers.delete(id); saveDraftNow(id); }, AUTOSAVE_MS));
}

// Un seul enregistrement en vol par message ; ce qui est modifié pendant la requête reste « non enregistré »
// puis part au passage suivant. Hors ligne : aucune requête, le brouillon reste local et non enregistré.
async function saveDraftNow(id, { overwrite = false } = {}) {
  const full = state.details[id], meta = state.draftMeta[id] || {};
  if (!full || full.failed || meta.version === undefined || state.offline) return;
  if (meta.saving) { setMeta(id, { again: true }); return; }
  if (meta.conflict && !overwrite) return;
  const local = localDraft(id);
  if (!overwrite && sameDraft(local, savedDraft(id)) && !meta.error && !meta.aiAssisted) return;
  setMeta(id, { saving: true, again: false, error: null });
  try {
    const draft = await api.saveDraft(id, withBase({ ...local, ...(meta.aiAssisted?{aiAssisted:true}:{}) }, meta.version));
    if (draft.previousDraftKept) notify('Un ancien brouillon est conservé chez le fournisseur.');
    const cur = state.details[id];
    if (cur) cur.draft = draft;
    const row = state.data.messages.find(m => m.id === id) || (state.selectedRow?.id === id ? state.selectedRow : null);
    if (row) { row.draft = { savedAt: draft.savedAt, gmail: draft.gmail, synced: draft.synced ?? draft.gmail }; if (Number.isInteger(draft.version)) row.draftVersion = draft.version; }
    const again = state.draftMeta[id]?.again;
    setMeta(id, { saving: false, again: false, version: Number.isInteger(draft.version) ? draft.version : meta.version, saved: local, savedText: local.text, savedAt: draft.savedAt, conflict: false, error: null });
    if (again || changed(id)) scheduleAutosave(id);
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
  const version = versionOf(full), saved = serverDraft(full);
  if (keepMine) {
    setMeta(id, { version, saved, savedText: saved.text, conflict: false, error: null });
    return saveDraftNow(id, { overwrite: true });
  }
  set(s => {
    const drafts = { ...s.drafts }, composeTo = { ...s.composeTo };
    delete drafts[id]; delete composeTo[id];
    return { drafts, composeTo, ...(state.selectedId===id && state.composing?{composing:saved.mode}:{}), draftMeta: { ...s.draftMeta, [id]: { version, saved, savedText: saved.text, savedAt: full.draft?.savedAt, conflict: false, error: null } } };
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

function flatFolders(s,expandAll=false) {
  const rows = [];
  const walk = (parent, depth) => s.data.folders.filter(f => (s.profileId==='all' || f.p === s.profileId) && f.parent === parent).forEach(f => {
    rows.push({ f, depth, kids: s.data.folders.some(c => c.parent === f.id) });
    if (expandAll || s.collapsed[f.id]===false || !s.data.folders.some(c=>c.parent===f.id)) walk(f.id, depth + 1);
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
  const inProfile = s.paged ? d.messages : d.messages.filter(m => (s.profileId==='all' || m.p === s.profileId) && (s.folder || !m.archived));
  const byNav = s.paged ? inProfile : s.folder
    ? inProfile.filter(m => folderSet(s.folder).has(m.folderId))
    : inProfile.filter(m => s.nav === 'all' || (s.nav === 'unread' && m.unread) || (s.nav === 'todo' && m.flagged) || (s.nav === 'drafts' && m.draft));
  const q = s.query.trim().toLowerCase();
  const list = s.paged ? byNav : byNav.filter(m => (s.channel === 'all' || m.channel === s.channel) && (!q || (m.from + m.subject + m.preview).toLowerCase().includes(q)));
  const sel = inProfile.find(m => m.id === s.selectedId)
    || (s.paged && s.selectedRow?.id === s.selectedId && (s.profileId==='all' || s.selectedRow.p === s.profileId) && (s.fromPerson || !s.selectedRow.archived) ? s.selectedRow : null);
  const counts = s.paged && s.counts ? s.counts : {
    all: inProfile.length, unread: inProfile.filter(m => m.unread).length, todo: inProfile.filter(m => m.flagged).length,
    drafts: inProfile.filter(m => m.draft).length, folders: null,
  };

  const contactsMine = s.profileId==='all'?(d.unifiedContacts || []):d.contacts.filter(c => c.p === s.profileId);
  const cq = s.contactQuery.trim().toLowerCase();
  const contacts = contactsMine
    .filter(c => (s.group === 'all' || c.g.includes(s.group) || (d.personGroups || []).find(g=>g.id===s.group)?.members.includes(c.id)) && (!cq || (c.name + c.title + (c.identities || []).map(i=>i.value).join(' ')).toLowerCase().includes(cq)))
    .sort(s.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.order - b.order);

  return {
    profile, inProfile, byNav, list, sel, contactsMine, contacts, counts,
    // Brouillon de la sélection modifié depuis le dernier enregistrement (texte, mode ou destinataire).
    draftChanged: !!sel && s === state && changed(sel.id),
    // Canaux proposés : en mode paginé, ceux des comptes du profil (la page ne les contient pas tous).
    channels: s.paged ? [...new Set(profile.accounts.map(a => a.channel))] : [...new Set(byNav.map(m => m.channel))],
    picked: contacts.filter(c => s.picked[c.id]),
    folders: flatFolders(s),
    allFolders:flatFolders(s,true),
    folderCount: id => {
      if (counts.folderUnread) return counts.folderUnread[id] || 0;
      const set = folderSet(id); return inProfile.filter(m => m.unread && set.has(m.folderId)).length;
    },
    viewTitle: s.folder ? (d.folders.find(f => f.id === s.folder)?.name || '') : NAV.find(n => n[0] === s.nav)[1],
    groups:[...GROUPS.filter(([id])=>id==='all' || contactsMine.some(c=>c.g.includes(id))),...(d.personGroups || []).map(g=>[g.id,g.name])],
    groupTitle: (d.personGroups || []).find(g=>g.id===s.group)?.name || GROUPS.find(g => g[0] === s.group)?.[1] || 'Contacts',
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
  const s = state, sel = s.ai?.newMail?state.details[s.ai.forId]:derive(s).sel;
  if (!s.ai || !sel || s.ai.loading || s.ai.memoryBusy || !s.data.ai?.configured) return;
  const newMail=!!s.ai.newMail,cid=newMail?s.newMail?.cid:null,fields=newMail?JSON.stringify(mailFields(s.newMail)):null;
  const mode = s.ai.mode, forId = sel.id, request = ++aiRequest, version = selectionVersion, profileId = s.profileId;
  set({ ai: { ...s.ai, loading: true, result: null, error: null, forId } });
  let result = null, error = null;
  try {
    result = mode === 'summary' ? await api.summarize(forId, regenerate)
      : mode === 'classify' ? await api.classify(forId, regenerate) : await api.draftReply(forId, s.aiTone, s.aiIntent);
  } catch (e) {
    error = e.message;
  }
  if (request === aiRequest && version === selectionVersion && profileId === state.profileId && (newMail ? state.newMailOpen && state.newMail?.messageId===forId && state.newMail.cid===cid && JSON.stringify(mailFields(state.newMail))===fields : state.selectedId === forId) && state.ai?.forId === forId && state.ai.mode === mode) {
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
  const sel = state.ai?.newMail && state.newMailOpen?state.details[state.ai.forId]:derive(state).sel;
  if (!sel) return;
  aiRequest++;
  const result = state.details[sel.id]?.aiResults?.[mode] || null;
  const wasOpen = !!state.ai;
  set({ ai: { ...(state.ai?.newMail && state.newMailOpen?{newMail:true}:{}), mode, result, folderId: result?.folderId ?? null, error: null, loading: false, forId: sel.id }, moveOpen: false });
  if (!wasOpen) pushLayer('ai');
}

// ---------- Assistant de connexion ----------

let syncTimer, wizardVersion = 0, linkRequest = 0;
function whatsappAccountName() {
  const used=new Set((state.data.profiles.find(p=>p.id===state.profileId)?.accounts || []).map(a=>a.name));
  let name='WhatsApp',n=2;while(used.has(name)) name=`WhatsApp ${n++}`;return name;
}
function svcInit(key, name) {
  const def = state.data.services[key], fields = {};
  (def.fields || []).forEach(f => { fields[f[0]] = f[2]; });
  return { step: key==='whatsapp'?'auth':'config', svc: key, name: name || (key==='whatsapp'?whatsappAccountName():def.name), fields, perms: def.auth === 'qr' ? { read: true, drafts: true, send: true } : { read: true }, ...(def.auth === 'qr' ? { win: 7 } : {}) };
}
function openWizard(svc, name, account = null) {
  const c = { wizardId: ++wizardVersion, step: 'pick', svc: null, profile: account?.profileId || (state.profileId==='all'?state.data.profiles.find(p=>p.id!=='all')?.id:state.profileId), name: '', perms: { read: true }, win: 365,historyDays:365, fields: {}, progress: 0, fromAccount: !!name };
  if (svc) Object.assign(c, svcInit(svc, name));
  if (account) Object.assign(c, {historyDays:account.historyDays ?? 0, accountId: account.id, win: svc === 'whatsapp' ? 7 : account.windowDays || 30, perms: Object.fromEntries((svc === 'whatsapp' ? ['read','drafts','send'] : ['read', ...(account.perms || [])]).map(p => [p, true])) });
  set({ c, menu: false, accountMenu: null });
  if(svc==='whatsapp') startWhatsAppLink();
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
    const { linkId } = await api.startWhatsAppLink({ profileId: c.profile, name: c.name.trim(), windowDays: 7,  ...(c.accountId ? { accountId: c.accountId, reconnect: true } : {}) });
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
  if(state.auth?.legacy){location.href=(c.svc==='outlook'?'/oauth/microsoft/start?':'/oauth/google/start?')+new URLSearchParams({profile:c.profile,name:c.name.trim(),win:c.win,historyDays:c.historyDays ?? 365,perms:perms.join(','),...(c.accountId?{account:c.accountId}:{})});return;}
  try {const result=await api.startOAuth(c.svc==='outlook'?'microsoft':'google',{ profile:c.profile,name:c.name.trim(),win:c.win,historyDays:c.historyDays ?? 365,perms:perms.join(','),...(c.accountId?{account:c.accountId}:{}) });location.assign(result.url);}catch(error){setC({busy:false,error:error.message});}
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
// Enregistrement automatique différé ; une seule création ou écriture en vol. Les champs restent modifiables
// pendant la requête : ce qui est saisi entre-temps reste « non enregistré » et part au passage suivant.
// Jamais d'écriture automatique après une erreur, un conflit, ou hors ligne.
let newMailTimer = null, newMailFlight = null;
const accountKnown = id => state.data?.profiles?.some(p => p.accounts.some(a => a.id === id));
const compositionFromServer=full=>{const c=newComposition({ messageId: full.id, version: versionOf(full), accountId: full.accountId, to: full.draft?.to || '', cc: full.draft?.cc || '', subject: full.subject || '', text: full.draft?.text || '', savedAt: full.draft?.savedAt, synced: full.draft?.synced, aiAssisted:full.requiresPreview!==false,aiPersisted:true });return {...c,saved:mailFields(c)};};
// Le buffer existe dès sa création locale, avant même que POST /drafts fournisse un identifiant.
function patchComposition(cid,patch,fallback=null) {
  const current=state.newMail?.cid===cid;
  const base=current?state.newMail:compositionsByCid.get(cid) || [...compositionBuffers.values()].find(c=>c.cid===cid) || fallback;
  if(!base) return;
  const next={...base,...patch};
  if(current) set({newMail:next});
  if(accountKnown(next.accountId)) {compositionsByCid.set(cid,next);if(next.messageId)compositionBuffers.set(next.messageId,next);}
}
function scheduleNewMailSave() {
  clearTimeout(newMailTimer);
  const c = state.newMail;
  if (!c?.accountId || c.busy || c.conflict || c.saveError || state.offline || !mailChanged(c)) return;
  const cid = c.cid;
  newMailTimer = setTimeout(() => { newMailTimer = null; if (state.newMail?.cid === cid) saveNewMail({ auto: true }); }, AUTOSAVE_MS);
}
async function saveNewMail({ auto = false } = {}) {
  clearTimeout(newMailTimer);
  const c = state.newMail;
  if (!c?.accountId || c.conflict) return null;
  if (state.offline) { if (!auto) set({ newMail: { ...c, error: 'Hors ligne : le brouillon reste ici, non enregistré.' } }); return null; }
  if (auto && c.saveError) return null;
  if (newMailFlight) {
    if (auto) return null; // le passage en cours replanifie si besoin
    await newMailFlight;
    return state.newMail?.cid === c.cid ? saveNewMail() : null;
  }
  // Rien de nouveau : la version connue suffit (aperçu sans écriture inutile).
  if (c.messageId && !mailChanged(c) && !c.saveError) return { c, input: withBase({ mode: 'new', ...mailFields(c) }, c.version) };
  newMailFlight = writeNewMail(c);
  try { return await newMailFlight; } finally { newMailFlight=null;scheduleNewMailSave(); }
}
async function writeNewMail(start) {
  const cid = start.cid, sent = mailFields(start);
  let c = { ...start };
  patchComposition(cid, { saving: true, error: null, saveError: null });
  try {
    if (!c.messageId) {
      const m = await api.createComposition(c.accountId);
      c = { ...c, messageId: m.id, version: versionOf(m) };
      patchComposition(cid, { messageId: c.messageId, version: c.version }, c);
    }
    const input = { mode: 'new', ...sent, ...(c.aiAssisted?{aiAssisted:true}:{}) };
    const draft = await api.saveDraft(c.messageId, withBase(input, c.version));
    if (draft.previousDraftKept) notify('Un ancien brouillon est conservé chez le fournisseur.');
    const version = Number.isInteger(draft.version) ? draft.version : c.version;
    patchComposition(cid, { messageId: c.messageId, version, saving: false, saved: sent, savedAt: draft.savedAt, synced: draft.synced ?? draft.gmail, aiPersisted:!!c.aiAssisted, saveError: null, conflict: false }, { ...c, ...sent });
    reload({ refresh: true }).catch(() => { /* l'enregistrement est déjà confirmé */ });
    return { c: { ...c, ...sent, version }, input: withBase(input, version) };
  } catch (e) {
    // Conflit : le texte saisi reste affiché ; rien n'est écrasé sans choix explicite (Recharger / Garder ma version).
    const conflict = e.status === 409 && e.code === 'draft_conflict';
    patchComposition(cid, { saving: false, conflict, saveError: conflict ? null : e.message }, c);
    return null;
  }
}
// Résolution explicite d'un conflit : relire la version du serveur, puis la reprendre ou la remplacer
// par une écriture conditionnelle sur cette version relue.
async function resolveNewMail(keepMine) {
  const c = state.newMail;
  if (!c?.conflict || !c.messageId || c.saving || c.busy) return;
  if (state.offline) return set({ newMail: { ...c, error: 'Hors ligne : la résolution demande le réseau.' } });
  const cid = c.cid;
  set({ newMail: { ...c, saving: true, error: null } });
  let full;
  try { full = await api.message(c.messageId); } catch (e) {
    if (state.newMail?.cid === cid) set({ newMail: { ...state.newMail, saving: false, error: e.message } });
    return;
  }
  if (state.newMail?.cid !== cid) return; // fermée ou remplacée entre-temps : rien n'est appliqué
  const server = compositionFromServer(full);
  if (keepMine) {
    patchComposition(cid,{version:server.version,saved:mailFields(server),saving:false,conflict:false,saveError:null});
    return saveNewMail();
  }
  patchComposition(cid,{...mailFields(server),version:server.version,saved:mailFields(server),savedAt:server.savedAt,synced:server.synced,saving:false,conflict:false,saveError:null,error:null});
}

// ---------- Actions ----------

const num = v => Number(v);
const firstOf = profileId => state.data.messages.find(m => (profileId==='all' || m.p === profileId) && !m.archived)?.id ?? null;

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
    rememberComposition();
    const pending=[...compositionsByCid.values()].reverse().find(c=>!c.messageId && accounts.some(a=>a.id===c.accountId) && (mailChanged(c) || c.saving));
    set({newMailOpen:true,newMail:pending || newComposition({accountId})});
  },
  newMailField: ({ field }, e) => {
    const c = state.newMail;
    if (!c || c.busy || (field === 'accountId' && (c.messageId || c.saving))) return;
    set({ newMail: { ...c, [field]: field === 'accountId' ? Number(e.target.value) : e.target.value, error: null } });
    scheduleNewMailSave();
  },
  closeNewMail: () => { if (!state.newMail?.busy) { aiRequest++;rememberComposition(); set({ newMailOpen: false, ...(state.ai?.newMail?{ai:null}:{}) }); } },
  newMailReload: () => resolveNewMail(false),
  newMailKeepMine: () => resolveNewMail(true),
  newMailConnect: () => { set({ newMailOpen: false }); openWizard(); },
  saveNewMail: () => { if (!state.newMail?.busy) saveNewMail(); },
  // Aperçu : champs figés (busy) pendant l'enregistrement puis la vérification ; résultat lié à cette composition.
  previewNewMail: async () => {
    const c0 = state.newMail;
    if (state.confirm || !c0 || c0.busy) return;
    if (state.offline) return set({ newMail: { ...c0, error: 'Hors ligne : la vérification avant l’envoi demande le réseau.' } });
    const cid = c0.cid, ours = () => state.newMail?.cid === cid && state.newMailOpen;
    set({ newMail: { ...c0, busy: true, error: null } });
    const saved = await saveNewMail();
    if (!saved || !ours()) { patchComposition(cid, { busy: false }); return; }
    const { c, input } = saved;
    try {
      const preview = await api.previewSend(c.messageId, input);
      if (!ours() || state.confirm) { patchComposition(cid, { busy: false }); return; }
      set({ newMailOpen: false, newMail: { ...state.newMail, busy: false }, confirm: { kind: 'send', direct:preview.requiresConfirmation===false && !c.aiAssisted, newMail: true, messageId: c.messageId, input, preview, busy: false, error: null } });
      if(state.confirm.direct)await actions.confirmSend();
      else pushLayer('confirm');
    } catch (e) {
      const conflict = e.status === 409 && e.code === 'draft_conflict';
      patchComposition(cid, { busy: false, ...(conflict ? { conflict: true } : { error: e.message }) });
    }
  },
  aiNewMail: async () => {
    const c0=state.newMail;if(!c0 || c0.busy || state.ai?.newMail)return;
    aiRequest++;const cid=c0.cid;set({newMail:{...c0,busy:true,error:null}});
    const saved=await saveNewMail();
    if(!saved || state.newMail?.cid!==cid || !state.newMailOpen){patchComposition(cid,{busy:false});return;}
    try{const full=await api.message(saved.c.messageId);if(state.newMail?.cid!==cid || !state.newMailOpen)return;
      set(s=>({details:{...s.details,[full.id]:full},newMail:{...s.newMail,busy:false},ai:{newMail:true,mode:'draft',forId:full.id,result:null,error:null,loading:false}}));
    }catch(e){patchComposition(cid,{busy:false,error:e.message});}
  },
  toggleProfileMenu: () => set({ menu: !state.menu, accountMenu: null }),
  selectProfile: ({ id }) => {
    storage.set('relay.profile',id);
    duplicateActionVersion++;
    selectionVersion++; rememberComposition();
    if (state.drawer) backFrom('drawer');
    filtersChanged({waMention:null,waParticipants:{},waParticipantsBusy:null,contactHistory:null,contactHistoryError:null,historyBusy:false,duplicates:null,duplicatesError:null,duplicatesBusy:false,duplicatesReview:null,duplicatesKeep:null,duplicatesLimit:25, newMailOpen: false, profileId: id, personOpen:null,person:null,personError:null,personMerge:'',personValue:'',personAddOpen:false,personBusy:false,network:null,networkError:null,groupEditor:null,contactImport:false,fromPerson:false, menu: false, accountMenu: null, picked: {}, group: 'all', channel: 'all', query: '', selectedId: state.paged ? null : firstOf(id), selectedRow: null, folder: null, ai: null, moveOpen: false, creating: false, composing: null, pane: 'list' });
    if(state.app==='duplicates')loadDuplicates();if(state.app==='history')loadContactHistory();if(state.app==='contacts')loadNetwork();
  },
  selectApp: ({ app }) => { if (state.drawer) backFrom('drawer'); set({ app, ai: null, moveOpen: false,duplicatesReview:null });if(app==='duplicates')loadDuplicates();if(app==='history')loadContactHistory();if(app==='contacts')loadNetwork();if(app==='settings')loadMailSettings(); },
  selectNav: ({ id }) => { if (state.drawer) backFrom('drawer'); filtersChanged({ nav: id, channel: 'all', folder: null }); },
  openDrawer: () => { set({ drawer: true }); pushLayer('drawer'); },
  closeDrawer: () => backFrom('drawer'),
  mobileBack: () => backFrom('reader'),
  loadMore: () => loadList({ append: true }),
  retryList: () => loadList(),
  loadOlder: ({ id }) => loadOlder(Number(id)),
  draftReload: ({ id }) => resolveConflict(Number(id), false),
  draftKeepMine: ({ id }) => resolveConflict(Number(id), true),
  openMailSettings:()=>{if(state.drawer)backFrom('drawer');set({app:'settings',accountMenu:null,mailSettingsPreview:null});loadMailSettings();},
  historyWindowChange:({id},e)=>set({mailSettingsDays:{...state.mailSettingsDays,[id]:Number(e.target.value)},mailSettingsPreview:null}),
  reviewHistoryWindow:async({id})=>{if(state.mailSettingsBusy)return;set({mailSettingsBusy:Number(id),mailSettingsError:null});try{const review=await api.previewHistoryWindow(Number(id),state.mailSettingsDays[id]);set({mailSettingsPreview:review});}catch(e){set({mailSettingsError:e.message});}finally{set({mailSettingsBusy:null});}},
  cancelHistoryWindow:()=>set({mailSettingsPreview:null}),
  applyHistoryWindow:async()=>{const r=state.mailSettingsPreview;if(!r || state.mailSettingsBusy)return;set({mailSettingsBusy:r.accountId,mailSettingsError:null});try{const result=await api.saveHistoryWindow(r.accountId,r.requestedDays,r.revision,r.identity);set({mailSettingsPreview:null,details:{},person:null,personOpen:null,network:null,ai:null});await reload({refresh:true});await loadMailSettings();notify(`Historique enregistré : ${result.cleanup.removed} conversations retirées du cache. Tes messages chez le fournisseur et tes brouillons sont conservés.`);}catch(e){set({mailSettingsError:e.message,mailSettingsPreview:null});}finally{set({mailSettingsBusy:null});}},
  retryMailDisplay:({id})=>{const full=state.details[id];if(full)loadMailDisplay(Number(id),full);},
  toggleMailText:({id})=>set({mailText:{...state.mailText,[id]:!state.mailText[id]}}),
  contactView:({view})=>{set({contactView:view});if(!state.network)loadNetwork();},
  networkDays:(_,e)=>{set({networkDays:Number(e.target.value)});loadNetwork();},
  refreshNetwork:()=>loadNetwork(),
  openGroup:({id})=>{const g=(state.data.personGroups || []).find(g=>g.id===id);set({groupEditor:id || 'new',groupName:g?.name || '',groupQuery:''});},
  closeGroup:()=>set({groupEditor:null,groupName:''}),
  groupQuery:(_,e)=>set({groupQuery:e.target.value}),
  groupName:(_,e)=>set({groupName:e.target.value}),
  saveGroup:async()=>{if(state.groupBusy)return;const profile=state.profileId,id=state.groupEditor;set({groupBusy:true});try{const g=await api.saveGroup(profile,{name:state.groupName},id==='new'?null:id);if(profile===state.profileId){await reload({refresh:true});set({groupEditor:id==='new'?g.id:null,group:g.id});await loadNetwork();}}catch(e){fail(e);}finally{set({groupBusy:false});}},
  toggleGroupMember:async({group,id,on})=>{if(state.groupBusy)return;const profile=state.profileId;set({groupBusy:true});try{await api.groupMember(profile,group,id,on==='true');if(profile===state.profileId){await reload({refresh:true});await loadNetwork();}}catch(e){fail(e);}finally{set({groupBusy:false});}},
  selectGroup: ({ id }) => { if (state.drawer) backFrom('drawer'); set({ group: id, app: 'contacts' });if(!state.network)loadNetwork(); },

  // Dossiers
  newRootFolder: () => set({ creating: 'root', folderDraft: '' }),
  addSubfolder: ({ id }, e) => { e.stopPropagation(); set(s => ({ creating: id, folderDraft: '', collapsed: { ...s.collapsed, [id]: false } })); },
  toggleFolder: ({ id }, e) => { e.stopPropagation(); const initial=id.startsWith('account:')?false:state.data.folders.some(f=>f.parent===id);const collapsed={...state.collapsed,[id]:!(state.collapsed[id] ?? initial)};storage.set('relay.folderExpansion',JSON.stringify(collapsed));set({collapsed}); },
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
  openAccount: ({ name,id }) => {
    const acc = derive(state).profile.accounts.find(a => id?a.id===Number(id):a.name === name);
    if (acc && state.data.services[acc.svc]?.real) return set({ accountMenu: state.accountMenu === acc.id ? null : acc.id, menu: false });
    if (!acc || acc.c === 'ok' || !acc.svc) return;
    const def = state.data.services[acc.svc];
    if (def.disabled) openWizard(); else openWizard(acc.svc, acc.name);
  },
  accountPermissions: ({ id }) => {
    const acc = derive(state).profile.accounts.find(a => a.id === Number(id));
    if (acc) openWizard(acc.svc, acc.name, acc);
  },
  accountHistory: async ({id,action}) => {
    set({accountMenu:null});
    try {await api.importHistory(Number(id),action || 'start');await reload({refresh:true});set({toast:action==='pause'?'Import en pause.':'Import de l’historique choisi en arrière-plan.'});}catch(e){fail(e);}
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
    set({ selectedId: m.id, selectedRow: m, fromPerson:false, moveOpen: false, composing: null, ai: null, pane: 'reader' });
    pushLayer('reader');
    if (m.kind === 'new') {
      try {
        const cached = compositionBuffers.get(m.id);
        if (cached) { set({ newMailOpen: true, newMail: { ...cached, busy: false } }); return; }
        const full = await api.message(m.id);
        if (selectionVersion !== version || state.profileId !== profileId || state.selectedId !== m.id) return;
        rememberComposition();
        set({ newMailOpen: true, newMail: compositionFromServer(full) });
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
    set({ composing:mode });
    setMeta(state.selectedId,{localMode:mode});
    if (derive(state).sel?.channel !== 'whatsapp') pushLayer('compose');
    const id = state.selectedId;
    if (changed(id)) scheduleAutosave(id);
  },
  closeComposer: () => { if (layers.includes('compose')) backFrom('compose'); else set({ composing: null }); },
  composeTo: (_, e) => { const id = state.selectedId, v = e.target.value; set(s => ({ composeTo: { ...s.composeTo, [id]: v } })); scheduleAutosave(id); },
  waMessageMenu:({id})=>{if(!state.confirm)set({waMessageMenu:state.waMessageMenu?.conversationId===state.selectedId && state.waMessageMenu.messageId===id?null:{conversationId:state.selectedId,messageId:id}});},
  waReply:({id})=>{
    if(state.confirm)return;const conversation=state.selectedId,full=state.details[conversation];
    if(!full || ![full.waId,...(full.trail||[]).map(x=>x.waId)].includes(id))return;
    setMeta(conversation,{localReplyTo:id});set({waMessageMenu:null});scheduleAutosave(conversation);
    requestAnimationFrame(()=>document.querySelector(`textarea[data-key="draft-${conversation}"]`)?.focus());
  },
  waReplyCancel:()=>{if(state.confirm)return;setMeta(state.selectedId,{localReplyTo:null});scheduleAutosave(state.selectedId);},
  waReact:async({id,emoji})=>{
    const conversation=state.selectedId,full=state.details[conversation];
    if(state.confirm || state.waReacting || state.offline || !full)return;
    set({waReacting:conversation,waMessageMenu:null});
    try{await api.reactWhatsApp(conversation,{messageId:id,emoji});if(known(conversation)){set(s=>({details:{...s.details,[conversation]:{...s.details[conversation],refreshing:true}}}));await loadDetails(conversation);}}
    catch(e){fail(e);}finally{set({waReacting:null});}
  },
  waMentionRetry:()=>{if(state.waMention)loadMentionParticipants(state.waMention.id,true);},
  waMentionClose:()=>set({waMention:null}),
  waMentionCursor:(_,e)=>{if(e.type!=='keyup' || ['ArrowLeft','ArrowRight','Home','End'].includes(e.key))updateMentionQuery(e.target);},
  waMentionKeys:(_,e)=>{
    if(!state.waMention || state.waMention.id!==state.selectedId || e.isComposing)return;
    const options=mentionOptions();
    if(['ArrowDown','ArrowUp'].includes(e.key) && options.length){e.preventDefault();set({waMention:{...state.waMention,active:(state.waMention.active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length}});}
    else if(['Enter','Tab'].includes(e.key) && options.length){e.preventDefault();actions.waMentionSelect({jid:options[state.waMention.active%options.length].jid});}
    else if(e.key==='Escape'){e.preventDefault();set({waMention:null});}
  },
  waMentionSelect:({jid})=>{
    const q=state.waMention,id=state.selectedId;if(!q || q.id!==id || state.confirm)return;
    const member=mentionOptions().find(p=>p.jid===jid),draft=localDraft(id);
    if(!member || draft.text.slice(q.from,q.to)!=='@'+q.query)return;
    if((draft.mentions||[]).length>=50)return notify('50 mentions maximum par message.');
    const text=draft.text.slice(0,q.from)+member.token+' '+draft.text.slice(q.to);
    const selected={jid,start:q.from,end:q.from+member.token.length,name:member.name,phone:member.phone};
    const mentions=[...mentionEdits(draft.text,text,draft.mentions),selected].sort((a,b)=>a.start-b.start);
    setMeta(id,{localMentions:mentions});set(s=>({drafts:{...s.drafts,[id]:text},waMention:null}));scheduleAutosave(id);
    requestAnimationFrame(()=>{const el=document.querySelector(`textarea[data-key="draft-${id}"]`);if(el && state.selectedId===id && localDraft(id).text===text){el.value=text;el.focus();el.setSelectionRange(selected.end+1,selected.end+1);}});
  },
  waMentionRemove:({start})=>{
    if(state.confirm)return;const id=state.selectedId,draft=localDraft(id),m=draft.mentions?.find(m=>m.start===Number(start));if(!m)return;
    updateDraftText(id,draft.text.slice(0,m.start)+draft.text.slice(m.end));set({waMention:null});
  },
  waEmojiToggle:()=>{if(!state.confirm)set({waEmoji:!state.waEmoji});},
  waEmojiInsert:({emoji})=>{
    if(state.confirm)return;const id=state.selectedId,el=document.querySelector(`textarea[data-key="draft-${id}"]`);
    if(!el)return;const text=el.value,start=el.selectionStart ?? text.length,end=el.selectionEnd ?? start;
    const value=text.slice(0,start)+emoji+text.slice(end);updateDraftText(id,value);set({waEmoji:false,waMention:null});
    requestAnimationFrame(()=>{const node=document.querySelector(`textarea[data-key="draft-${id}"]`);if(node && state.selectedId===id && localDraft(id).text===value){node.value=value;node.focus();node.setSelectionRange(start+emoji.length,start+emoji.length);}});
  },
  waAttach:async(_,e)=>{
    const file=e.target.files?.[0],id=state.selectedId;e.target.value='';
    if(!file || state.confirm || state.waUploading)return;
    if(file.size>10*1024*1024)return notify('Image trop volumineuse (10 Mo maximum).');
    set({waUploading:id});
    try {const attachment=await api.uploadWhatsApp(id,file);set(s=>({waAttachments:{...s.waAttachments,[id]:attachment}}));}
    catch(e){fail(e);}finally{set({waUploading:null});}
  },
  waAttachRemove:()=>{if(state.confirm)return;set(s=>({waAttachments:{...s.waAttachments,[s.selectedId]:null}}));},
  draft: (_, e) => {const id=state.selectedId;updateDraftText(id,e.target.value);if(!e.isComposing)updateMentionQuery(e.target);},
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
  aiClose: () => { if(state.ai?.newMail){aiRequest++;set({ai:null});return;} if (layers.includes('ai')) backFrom('ai'); else { aiRequest++; set({ ai: null }); } },
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
    if(state.ai?.newMail && state.newMailOpen && state.newMail?.messageId===id && text && !state.ai.loading){set({newMail:{...state.newMail,text,aiAssisted:true},ai:null});scheduleNewMailSave();return;}
    if (id == null || !text || state.selectedId !== id || state.ai?.mode !== 'draft' || state.ai.loading) return;
    const email = derive(state).sel?.channel !== 'whatsapp';
    if (layers.at(-1) === 'ai') {
      // Mobile : l'entrée de l'assistant devient celle de la rédaction ; « Retour » fermera la rédaction, pas la lecture.
      if (email && !layers.includes('compose')) {
        layers[layers.length - 1] = 'compose';
        try { history.replaceState?.({ relay: 'compose', depth: layers.length }, ''); } catch { /* historique indisponible */ }
      } else { layers.pop(); try { history.back?.(); } catch { /* sans historique */ } layers.push('__skip'); }
    }
    setMeta(id,{localMode:'reply',aiAssisted:true,localMentions:[]});set({waMention:null});
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
  focusContact: async ({ id }) => {
    const profile=state.profileId;
    if(!derive(state).contactsMine.some(c=>c.id===id))return;
    set({focusId:id,personOpen:id,person:null,personError:null,personBusy:false,personMerge:'',personValue:'',personAddOpen:false});
    try {const person=await api.person(profile,id);if(state.profileId===profile && state.personOpen===id)set({person});}catch(e){if(state.profileId===profile && state.personOpen===id)set({personError:e.message});}
  },
  closePerson:()=>set({personOpen:null,person:null,personError:null,personMerge:'',personValue:'',personAddOpen:false}),
  togglePersonAdd:(_,e)=>{e.preventDefault();set({personAddOpen:!state.personAddOpen});},
  togglePersonMerge:(_,e)=>{e.preventDefault();set({personMergeOpen:!state.personMergeOpen});},
  personField:({field},e)=>{if(['personKind','personValue','personMerge'].includes(field))set({[field]:e.target.value});},
  personMore:async()=>{
    const profile=state.profileId,id=state.personOpen,old=state.person;if(!old?.timeline.nextOffset || state.personBusy)return;
    set({personBusy:true});try{const value=await api.person(profile,id,{offset:old.timeline.nextOffset});if(state.profileId===profile && state.personOpen===id)set({person:{...value,timeline:{...value.timeline,items:[...new Map([...old.timeline.items,...value.timeline.items].map(m=>[m.id,m])).values()]}}});}catch(e){fail(e);}finally{if(state.profileId===profile && state.personOpen===id)set({personBusy:false});}
  },
  addPersonIdentity:async()=>{
    const profile=state.profileId,id=state.personOpen;if(state.personBusy)return;set({personBusy:true,personError:null});
    try{const person=await api.addContactIdentity(profile,id,{kind:state.personKind,value:state.personValue});if(state.profileId===profile && state.personOpen===id)set({person,personValue:'',personAddOpen:false});await reload({refresh:true});}catch(e){if(state.profileId===profile && state.personOpen===id)set({personError:e.message});}finally{if(state.profileId===profile && state.personOpen===id)set({personBusy:false});}
  },
  removePersonIdentity:async({kind,normalized})=>{
    const profile=state.profileId,id=state.personOpen;if(state.personBusy)return;set({personBusy:true});
    try{const person=await api.removeContactIdentity(profile,id,{kind,normalized,source:'manual'});if(state.profileId===profile && state.personOpen===id)set({person});await reload({refresh:true});}catch(e){fail(e);}finally{if(state.profileId===profile && state.personOpen===id)set({personBusy:false});}
  },
  mergePerson:async()=>{
    const profile=state.profileId,id=state.personOpen,source=state.personMerge;if(!source || state.personBusy)return;set({personBusy:true,personError:null});
    try{const person=await api.mergeContacts(profile,id,source);if(state.profileId===profile && state.personOpen===id)set({person,personMerge:''});await reload({refresh:true});}catch(e){if(state.profileId===profile && state.personOpen===id)set({personError:e.message});}finally{if(state.profileId===profile && state.personOpen===id)set({personBusy:false});}
  },
  undoPersonMerge:async({id:event})=>{
    const profile=state.profileId,id=state.personOpen;if(state.personBusy)return;set({personBusy:true});
    try{await api.undoContactMerge(profile,event);const person=await api.person(profile,id);if(state.profileId===profile && state.personOpen===id)set({person,personMerge:''});await reload({refresh:true});}catch(e){fail(e);}finally{if(state.profileId===profile && state.personOpen===id)set({personBusy:false});}
  },
  personConversation:async({id})=>{
    const profile=state.profileId,personId=state.personOpen;if(!state.person?.timeline.items.some(m=>m.id===Number(id)&&(profile==='all' || m.p===profile)))return;
    let m;try{m=await api.message(Number(id));}catch(e){fail(e);return;}if(state.profileId!==profile || state.personOpen!==personId || (profile!=='all' && m.p!==profile))return;
    ++selectionVersion;rememberComposition();filtersChanged({personOpen:null,person:null,fromPerson:true,app:'mail',nav:'all',channel:'all',folder:null,query:'',selectedId:m.id,selectedRow:m,details:{...state.details,[m.id]:m},composing:null,ai:null,pane:'reader'});pushLayer('reader');
  },
  duplicateTab:({tab})=>set({duplicatesTab:tab,duplicatesLimit:25,duplicatesReview:null}),
  duplicatesMore:()=>set({duplicatesLimit:state.duplicatesLimit+25}),
  rescanDuplicates:()=>actOnDuplicate(async profile=>{await api.scanDuplicates(profile);}),
  reviewDuplicate:({id})=>{const candidate=state.duplicates?.items.find(c=>c.id===id);if(candidate && !candidate.stale && !state.duplicatesBusy)set({duplicatesReview:candidate,duplicatesKeep:candidate.left.id});},
  cancelDuplicateReview:()=>set({duplicatesReview:null,duplicatesKeep:null}),
  duplicateKeep:(_,e)=>set({duplicatesKeep:e.target.value}),
  dismissDuplicate:({id,restore})=>{const c=state.duplicates?.items.find(c=>c.id===id);if(c)actOnDuplicate(profile=>api.dismissDuplicate(profile,id,{version:c.version,restore:restore==='true'}));},
  confirmDuplicateMerge:()=>{const c=state.duplicatesReview,keepId=state.duplicatesKeep;if(c)actOnDuplicate(profile=>api.mergeDuplicate(profile,c.id,{version:c.version,keepId,confirm:true}));},
  undoDuplicateMerge:({id})=>actOnDuplicate(profile=>api.undoContactMerge(profile,id)),
  undoSavedMerge:async({id})=>{const profile=state.profileId;if(state.historyBusy || state.offline)return;set({historyBusy:true,contactHistoryError:null});try{await api.undoContactMerge(profile,id);if(state.profileId===profile){await reload({refresh:true});await loadContactHistory();}}catch(e){if(state.profileId===profile)set({contactHistoryError:e.message});}finally{if(state.profileId===profile)set({historyBusy:false});}},
  openContactImport:()=>set({contactImport:true}),
  closeContactImport:()=>set({contactImport:false}),
  authorizeContacts:({id})=>{
    const acc=derive(state).profile.accounts.find(a=>a.id===Number(id));if(!acc)return;
    set({contactImport:false});openWizard(acc.svc,acc.name,acc);setC({perms:Object.fromEntries([...new Set([...(acc.perms || ['read']),'contacts'])].map(p=>[p,true]))});
  },
  importContacts:async({id})=>{
    const profile=state.profileId;if(state.contactImportBusy)return;set({contactImportBusy:Number(id)});
    try{const result=await api.importContacts(Number(id));await reload({refresh:true});if(state.profileId===profile)notify(`${result.imported} contacts importés dans ${state.data.profiles.find(p=>p.id===result.profileId)?.name || derive(state).profile.name}`);}catch(e){fail(e);}finally{set({contactImportBusy:null});}
  },
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
    if (!sel || state.confirm || state.waUploading) return;
    if (state.offline) return notify('Hors ligne : la vérification avant l’envoi demande le réseau.');
    const id = sel.id, profileId = state.profileId, request = ++previewRequest;
    clearTimeout(draftTimers.get(id));
    // Pendant l'attente, le compositeur est en lecture seule ; l'aperçu reste lié à cette demande précise.
    set({ confirm: { kind: 'send', messageId: id, request, input: null, preview: null, busy: true, error: null } });
    const ours = () => state.confirm?.request === request;
    if (state.draftMeta[id]?.saving) await new Promise(r => { const t = setInterval(() => { if (!state.draftMeta[id]?.saving) { clearInterval(t); r(); } }, 50); });
    if (state.draftMeta[id]?.version !== undefined && (changed(id) || state.draftMeta[id]?.aiAssisted)) await saveDraftNow(id);
    const meta = state.draftMeta[id] || {};
    if (!ours()) return;
    if (meta.conflict || meta.error || (meta.version !== undefined && changed(id))) {
      set({ confirm: null });
      if (meta.error) fail(new Error(meta.error));
      else if (!meta.conflict) notify('Brouillon non enregistré : vérification annulée.');
      return;
    }
    const sent = localDraft(id);
    const input = withBase({ ...sent, ...(state.waAttachments[id]?{attachmentId:state.waAttachments[id].id}:{}) }, meta.version);
    try {
      const preview = await api.previewSend(id, input);
      if (!ours()) return;
      // Sélection, profil ou brouillon modifiés pendant l'attente : cet aperçu ne correspond plus, il est écarté.
      if (state.profileId !== profileId || state.selectedId !== id || !sameDraft(localDraft(id), sent)) {
        set({ confirm: null });
        return notify('Le brouillon a changé pendant la vérification : vérifie à nouveau avant d’envoyer.');
      }
      set({ confirm: { kind: 'send', direct:preview.requiresConfirmation===false && !meta.aiAssisted, messageId: id, request, input, preview, busy: false, error: null } });
      if(state.confirm.direct)await actions.confirmSend();
      else pushLayer('confirm');
    } catch (e) {
      if (!ours()) return;
      set({ confirm: null });
      if (e.status === 409 && e.code === 'draft_conflict') setMeta(id, { conflict: true });
      else fail(e);
    }
  },
  confirmSend: async () => {
    const c = state.confirm;
    if (c?.kind !== 'send' || c.busy || c.stale || !c.preview) return;
    if (state.offline) return set({ confirm: { ...c, error: 'Hors ligne : rien n’a été envoyé.' } });
    set({ confirm: { ...c, busy: true, error: null } });
    let r;
    try {
      r = await api.send(c.messageId, { ...c.input, ...(c.direct?{direct:true}:{}), digest: c.preview.digest, ...(c.preview.approvalToken?{approvalToken:c.preview.approvalToken}:{}) });
    } catch (e) {
      // 409 : le contenu ou le fil a changé, il faut revérifier ; le bouton de confirmation est désactivé.
      // Une erreur Gmail incertaine (réseau, 5xx) consomme aussi la validation : vérifier à nouveau avant tout nouvel essai.
      set({ confirm: { ...c, direct:false, busy: false, stale: !/^Erreur (Gmail|Outlook)/.test(e.message), error: e.message } });
      return;
    }
    // Envoi confirmé par le serveur : plus rien ici ne doit inviter à renvoyer.
    const id = c.messageId;
    compositionBuffers.delete(id);
    for(const [cid,draft] of compositionsByCid) if(draft.messageId===id)compositionsByCid.delete(cid);
    // Texte saisi après l'aperçu : jamais effacé, il reste local et non enregistré (le brouillon envoyé a disparu).
    const newer = !c.newMail && !sameDraft(localDraft(id), { text: c.input.text, mode: c.input.mode, to: c.input.to ?? null,replyTo:c.input.replyTo ?? null,mentions:c.input.mentions || [] });
    clearTimeout(draftTimers.get(id));
    if (layers.at(-1) === 'confirm') { layers.pop(); try { history.back?.(); } catch { /* sans historique */ } layers.push('__skip'); }
    // L'entrée d'historique du compositeur devient neutre : le retour suivant ne rouvre ni ne ferme rien d'autre.
    if (layers.includes('compose')) layers[layers.lastIndexOf('compose')] = '__skip';
    set(s => {
      const drafts = { ...s.drafts }, composeTo = { ...s.composeTo }, details = { ...s.details }, draftMeta = { ...s.draftMeta };
      if (!newer) { delete drafts[id]; delete composeTo[id]; }
      delete details[id];
      if(newer) draftMeta[id]={...draftMeta[id],saving:false,again:false,conflict:true,error:null};
      else delete draftMeta[id];
      return { waAttachments:{...s.waAttachments,[id]:null}, confirm: null, composing: newer ? s.composing : null, drafts, composeTo, details, draftMeta, ...(c.newMail ? { newMail: null, newMailOpen: false, selectedId: s.selectedId === id ? null : s.selectedId, data: { ...s.data, messages: s.data.messages.filter(m => m.id !== id) } } : {}) };
    });
    const m = state.data.messages.find(x => x.id === id);
    if (m) m.draft = null;
    // La version après envoi n'est pas connue : jamais adopter silencieusement une écriture distante ultérieure.
    // Le buffer conservé devra être réconcilié explicitement avant toute nouvelle sauvegarde.
    const sent = r.draftRemoved === false ? 'Message envoyé. Le brouillon local est effacé ; son brouillon chez le fournisseur est conservé, supprime-le si besoin.' : 'Message envoyé.';
    notify(newer ? `${sent} Le texte modifié depuis la vérification est conservé : choisis la version à reprendre avant de l’enregistrer.` : sent);
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
      for(const [cid,draft] of compositionsByCid) if(draft.accountId===c.accountId)compositionsByCid.delete(cid);
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
  pickService: ({ svc }) => { if (!state.data.services[svc].disabled) {setC(svcInit(svc));if(svc==='whatsapp')startWhatsAppLink();} },
  cProfile: ({ id }) => setC({ profile: id }),
  cName: (_, e) => setC({ name: e.target.value }),
  cPerm: ({ perm }) => {
    const def = state.data.services[state.c.svc];
    if (def.available && !def.available.includes(perm)) return;
    setC(c => ({ perms: { ...c.perms, [perm]: !c.perms[perm] } }));
  },
  cHistory:(_,e)=>{const days=Number(e.target.value);if([0,30,90,180,365,730].includes(days))setC({historyDays:days,win:days || 365});},
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
    if (c.step === 'config') {
      setC({ step: 'auth', error: null });
    }
    else if (c.step === 'auth') c.svc === 'whatsapp' ? startWhatsAppLink() : state.data.services[c.svc].real ? startProviderAuth() : startSync();
    else if (c.step === 'done') { clearInterval(syncTimer); set({ c: null, app: 'mail', profileId: c.profile, selectedId: c.svc === 'whatsapp' ? state.data.messages.find(m => m.accountId === c.accountId && !m.archived)?.id ?? firstOf(c.profile) : c.profile === state.profileId ? state.selectedId : firstOf(c.profile), folder: null }); }
  },
};

document.addEventListener('error',e=>{
  const el=e.target;if(!el?.matches?.('.wa-media img,.wa-media video'))return;
  el.hidden=true;const fallback=el.closest('.wa-media')?.querySelector('.wa-media-error');if(fallback)fallback.hidden=false;
},true);
delegate(document, {
  change: 'change', click: 'click', dblclick: 'dblclick', input: 'input', keydown: 'keydown',keyup:'keyup', focusout: 'blur',
  dragstart: 'dragstart', dragover: 'dragover', dragleave: 'dragleave', drop: 'drop', pointerdown: 'pointerdown',
}, actions);

document.addEventListener('keydown', e => {
  if(e.defaultPrevented)return;
  if (e.key !== 'Escape') return;
  if(state.groupEditor){if(!state.groupBusy)actions.closeGroup();}
  else if(state.mailSettingsPreview){if(!state.mailSettingsBusy)actions.cancelHistoryWindow();}
  else if(state.personOpen){if(!state.personBusy)actions.closePerson();}
  else if (state.confirm) actions.confirmCancel();
  else if (state.ai?.newMail) actions.aiClose();
  else if (state.newMailOpen) actions.closeNewMail();
  else if (state.c) closeWizard();
  else if (state.ai) actions.aiClose();
  else if (state.menu || state.moveOpen || state.accountMenu) set({ menu: false, moveOpen: false, accountMenu: null });
});

// Navigateur seulement (absent des tests en machine virtuelle) : retour, format d'écran, clavier, réseau.
globalThis.addEventListener?.('popstate', onPopState);
const mobileQuery = globalThis.matchMedia?.('(max-width: 1000px)');
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
  if (Object.keys(state.draftMeta).some(id=>dirty(Number(id))) || [...compositionsByCid.values(),state.newMail].some(c=>c && (c.saving || c.conflict || mailChanged(c)))) { e.preventDefault(); e.returnValue = ''; }
});

api.session()
  .then(auth => { state.auth = auth; return api.state(listParams(state)); })
  .then(async data => {
    data=withUnified(data);
    if (data.page) {
      const profileId = data.profiles.some(p => p.id === state.profileId) ? state.profileId : data.profiles[0]?.id;
      if (profileId !== state.profileId) { state.profileId = profileId; await reload(); }
      else applyData(data, { paged: true, counts: data.counts || null, page: { ...data.page, key: listKey(state), loading: false, error: null } });
      if (!state.mobile && state.selectedId == null) set({ selectedId: state.data.messages[0]?.id ?? null, selectedRow: state.data.messages[0] || null });
    } else {
      state.profileId = data.profiles.some(p => p.id === state.profileId) ? state.profileId : data.profiles[0]?.id;
      set({ data, selectedId: state.mobile ? null : data.messages.find(m => m.p === state.profileId && !m.archived)?.id ?? null });
    }
    resumeFromRedirect();
    if (typeof globalThis.EventSource === 'function') {
      liveUpdates = createLiveUpdates({
        // Archive writes can arrive in bursts. Six open screens must stay below
        // the shared session limit while still following progress automatically.
        delayMs:()=>state.data?.profiles.some(p=>p.accounts.some(a=>['running','retrying'].includes(a.history?.status)))?ARCHIVE_REFRESH_MS:120,
        canRefresh: () => !!state.data && !state.c && !state.confirm && !state.offline,
        refresh: async () => {
          await reload({ refresh: true });
          if(state.app==='duplicates' && !state.duplicatesBusy)await loadDuplicates();
          if(state.app==='contacts' && !state.networkBusy)await loadNetwork();
          if(state.app==='history' && !state.historyBusy)await loadContactHistory();
          // Keep the first page of an open person timeline current as history
          // arrives. Do not reset a reader paging through older conversations.
          if(state.personOpen && !state.personBusy && (state.person?.timeline.items.length || 0)<=50){
            const personId=state.personOpen,profile=state.profileId;
            try{const person=await api.person(profile,personId);
              if(state.personOpen===personId && state.profileId===profile && !state.personBusy && (state.person?.timeline.items.length || 0)<=50)set({person,personError:null});
            }catch(e){if(state.personOpen===personId && state.profileId===profile)set({personError:e.message});}
          }
          const id = state.selectedId;
          if (state.app==='mail' && id != null && known(id) && !state.confirm) {
            detailRevisions.set(id, (detailRevisions.get(id) || 0) + 1);
            if (state.details[id]) set(s => ({ details: { ...s.details, [id]: { ...s.details[id], refreshing: true } } }));
            if (await loadDetails(id) === false) throw new Error('Actualisation du fil indisponible.');
          }
        },
      });
      liveUpdates.start();
      globalThis.addEventListener?.('pagehide', () => liveUpdates.stop());
      globalThis.addEventListener?.('pageshow', () => liveUpdates.start());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') liveUpdates.invalidate(); });
    }
  })
  // Réseau absent (TypeError de fetch) : message hors ligne, jamais de redirection vers la connexion.
  .catch(err => {
    if (state.offline || err instanceof TypeError) set({ loadError: 'offline' });
    else if (!state.auth) location.replace('/login');
    else set({ loadError: err.message });
  });
render();
