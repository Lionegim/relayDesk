// Interface mobile et PWA : liste paginée, historique, brouillons versionnés, navigation mobile, service worker.
// Exécution en machine virtuelle avec une API simulée : aucun réseau, aucune donnée réelle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { html, raw, when, cls } from '../public/js/dom.js';
import { createLiveUpdates } from '../public/js/live.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
// Les objets créés dans la machine virtuelle n'ont pas les prototypes de ce contexte : comparaison en JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------- Application (public/js/app.js) avec API, minuteries et historique simulés ----------

const profiles = [{ id: 'perso', name: 'Personnel', initials: 'P', accounts: [{ id: 1, name: 'Mail', channel: 'email', svc: 'gmail', perms: ['read', 'drafts', 'send'] }] }];
const row = (id, extra = {}) => ({ id, p: 'perso', accountId: 1, channel: 'email', from: `Exp ${id}`, subject: `Objet ${id}`, preview: '', sortAt: 1000 - id, count: 1, draftVersion: 3, ...extra });
const page = (messages, extra = {}) => ({ profiles, folders: [], contacts: [], services: {}, messages, page: { limit: 50, total: messages.length, hasMore: false, nextCursor: null, ...extra }, counts: { all: 9, unread: 2, todo: 1, drafts: 0, folders: {} } });

async function app({ mobile = false, state: first, onState, onMessage, live = false } = {}) {
  const calls = { state: [], message: [], saveDraft: [], preview: [], send: [], create: [] }, timers = [], listeners = {}, pushed = [], replaced = [];
  const api = {
    session: async () => ({ enabled: false }),
    state: params => { calls.state.push(params); return api.onState(params); },
    onState: onState || (async () => first || page([row(1), row(2)])),
    message: (id, params) => { calls.message.push({ id, params }); return api.onMessage(id, params); },
    onMessage: onMessage || (async id => ({ id, body: 'Corps', trail: [], draftVersion: 7, draft: null, history: { hasMore: false, nextCursor: null } })),
    saveDraft: (id, input) => { calls.saveDraft.push({ id, input }); return api.onSave(id, input); },
    onSave: async (id, input) => ({ text: input.text, savedAt: '2026-10-19T08:00:00.000Z', version: input.baseVersion + 1 }),
    previewSend: (id, input) => { calls.preview.push({ id, input }); return api.onPreview(id, input); },
    onPreview: async (id, input) => ({ from: 'a', to: ['b'], cc: [], subject: 's', body: input.text, digest: 'd' }),
    createComposition: accountId => { calls.create.push(accountId); return api.onCreate(accountId); },
    onCreate: async () => ({ id: 50, draftVersion: 4 }),
    send: (...a) => { calls.send.push(a); return Promise.resolve({ sent: true }); },
    updateMessage: async () => ({}),
  };
  const history = { pushState: s => pushed.push(s), replaceState: s => replaced.push(s), back: () => setImmediate(() => listeners.popstate?.()) };
  const c = {
    api, patch: () => {}, delegate: () => {}, renderApp: () => '', NAV: [['all', 'Boîte'], ['unread', 'Non lus'], ['todo', 'Avec drapeau'], ['drafts', 'Brouillons']], GROUPS: [['all', 'Tous']], SETTINGS: {}, WINDOWS: [7, 30, 90],
    localStorage: { getItem: () => null, setItem: () => {} }, document: { getElementById: () => ({ querySelector: () => null }), addEventListener: () => {} },
    queueMicrotask, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: n => { if (timers[n - 1]) timers[n - 1].fn = null; },
    setInterval: () => 1, clearInterval: () => {}, URLSearchParams, location: { search: '', replace: () => {} }, history, console,
    matchMedia: () => ({ matches: mobile, addEventListener: () => {} }), addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  if (live) {
    c.EventSource = class {
      constructor() { this.handlers={}; c.liveSource=this; }
      addEventListener(name,fn) { this.handlers[name]=fn; }
      emit(name) { this.handlers[name]?.(); }
      close() { this.closed=true; }
    };
    c.createLiveUpdates = options => createLiveUpdates({...options,EventSourceImpl:c.EventSource,delayMs:0});
  }
  vm.createContext(c);
  vm.runInContext(read('js/app.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.inspect=()=>state;globalThis.act=actions;globalThis.view=()=>derive(state);', c);
  await tick(6);
  const runTimers = async () => { const due = timers.splice(0).filter(t => t.fn); for (const t of due) t.fn(); await tick(6); };
  return { c, api, calls, timers, runTimers, listeners, pushed, replaced, s: () => c.inspect() };
}

test('live arrival updates the open conversation and list without replacing typed text or approving a send',async()=>{
 const u=await app({live:true,state:page([row(1,{channel:'whatsapp'})])});
 const wait=async condition=>{for(let i=0;i<100&&!condition();i++)await new Promise(r=>setTimeout(r,5));assert.ok(condition());};
 await wait(()=>!!u.s().details[1]);
 const selected=u.s().selectedId;u.s().drafts[1]='Mon texte encore en cours';
 u.api.onState=async()=>page([row(2),row(1,{channel:'whatsapp',sortAt:2000,count:2})]);
 u.api.onMessage=async()=>({id:1,body:'Nouveau message fictif reçu',trail:[],draftVersion:7,draft:null});
 u.c.liveSource.emit('connected');u.c.liveSource.emit('invalidate');
 await wait(()=>u.s().details[1]?.body==='Nouveau message fictif reçu');
 assert.equal(u.s().selectedId,selected);assert.equal(u.s().drafts[1],'Mon texte encore en cours');assert.equal(u.s().data.messages.length,2);
 assert.equal(u.calls.send.length,0);assert.equal(u.calls.preview.length,0);u.listeners.pagehide();
});

test('live invalidation during a delayed detail read discards that old response and refetches',async t=>{
 let resolveOld,reads=0;
 const fresh={id:1,body:'Latest fictional arrival',trail:[],draftVersion:7,draft:null};
 const u=await app({live:true,state:page([row(1,{channel:'whatsapp'})]),onMessage:()=>++reads===1?new Promise(r=>{resolveOld=r;}):Promise.resolve(fresh)});
 t.after(()=>u.listeners.pagehide());
 u.api.onState=async()=>page([row(1,{channel:'whatsapp',sortAt:2000,count:2})]);
 u.c.liveSource.emit('connected');
 for(let i=0;i<100&&u.s().data.messages[0].count!==2;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(u.s().data.messages[0].count,2);resolveOld({...fresh,body:'Old response'});
 for(let i=0;i<100&&u.s().details[1]?.body!==fresh.body;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(u.s().details[1].body,fresh.body);assert.equal(reads,2);assert.equal(u.calls.send.length,0);
});

test('live detail read failure recovers without needing another incoming event',async t=>{
 const u=await app({live:true,state:page([row(1,{channel:'whatsapp'})])});t.after(()=>u.listeners.pagehide());
 let reads=0;u.api.onMessage=async()=>{if(++reads===1)throw new Error('Temporary detail failure');return{id:1,body:'Recovered arrival',trail:[],draftVersion:7,draft:null};};
 u.api.onState=async()=>page([row(1,{channel:'whatsapp',sortAt:2000,count:2})]);u.c.liveSource.emit('connected');
 for(let i=0;i<500&&u.s().details[1]?.body!=='Recovered arrival';i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(u.s().details[1].body,'Recovered arrival');assert.ok(reads>=2);assert.equal(u.calls.send.length,0);
});

test('démarrage : profil fourni par le serveur, sans profil Anove imposé', async () => {
  const u = await app({ onState: async params => {
    if (params.profile && params.profile !== 'perso') throw new Error('Profil invalide');
    return page([row(1)]);
  } });
  assert.equal(u.s().loadError, null);
  assert.equal(u.s().profileId, 'perso');
  assert.equal(u.s().selectedId, 1);
  assert.equal(u.calls.state[0].profile, null);
  assert.equal(u.calls.state.at(-1).profile, 'perso');
});

test('liste paginée : filtres serveur, compteurs serveur, réponse obsolète ignorée', async () => {
  const u = await app();
  assert.equal(u.s().paged, true);
  assert.deepEqual(plain(u.calls.state[0]), { paged: 1, profile: null, nav: 'all', channel: 'all', limit: 50 });
  // Profil absent des profils fournis : premier profil, rechargé.
  assert.equal(u.s().profileId, 'perso');
  assert.equal(u.calls.state.at(-1).profile, 'perso');
  assert.equal(u.c.view().counts.all, 9, 'compteurs du serveur, pas de la page');
  assert.equal(u.s().selectedId, 1);
  const pending = [];
  u.api.onState = params => new Promise(r => pending.push({ params, r }));
  u.c.act.selectNav({ id: 'unread' });
  u.c.act.selectChannel({ id: 'email' });
  assert.deepEqual([pending[0].params.nav, pending[1].params.channel], ['unread', 'email']);
  pending[1].r(page([row(5)]));
  await tick();
  pending[0].r(page([row(9)])); // réponse plus ancienne, arrivée après
  await tick();
  assert.deepEqual(plain(u.s().data.messages.map(m => m.id)), [5]);
  // La sélection reste affichée hors de la page courante (même profil).
  assert.equal(u.c.view().sel.id, 1);
});

test('liste paginée : page suivante sans doublon, recherche différée', async () => {
  const u = await app({ state: page([row(1), row(2)], { hasMore: true, nextCursor: 'c1' }) });
  u.api.onState = async params => page([row(2), row(3)], { hasMore: false, nextCursor: null, cursor: params.cursor });
  await u.c.act.loadMore();
  await tick();
  assert.equal(u.calls.state.at(-1).cursor, 'c1');
  assert.deepEqual(plain(u.s().data.messages.map(m => m.id)), [1, 2, 3]);
  assert.equal(u.s().page.hasMore, false);
  const before = u.calls.state.length;
  u.c.act.search({}, { target: { value: 'éte' } });
  assert.equal(u.calls.state.length, before, 'pas d’appel à chaque frappe');
  await u.runTimers();
  assert.equal(u.calls.state.at(-1).q, 'éte');
});

test('brouillon : un seul enregistrement en vol, version du serveur, texte modifié pendant la requête non perdu', async () => {
  const u = await app();
  u.c.inspect().selectedId = 1;
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  const hold = [];
  u.api.onSave = (id, input) => new Promise(r => hold.push(() => r({ text: input.text, savedAt: '2026-10-19T08:00:00.000Z', version: input.baseVersion + 1 })));
  u.c.act.draft({}, { target: { value: 'Bonjour' } });
  assert.equal(u.s().draftMeta[1].version, 7, 'version lue du serveur, jamais supposée');
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1);
  assert.equal(u.calls.saveDraft[0].input.baseVersion, 7);
  u.c.act.draft({}, { target: { value: 'Bonjour Claire' } });
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1, 'pas de second enregistrement pendant le premier');
  hold.shift()();
  await tick(6);
  assert.equal(u.s().draftMeta[1].savedText, 'Bonjour');
  assert.equal(u.s().drafts[1], 'Bonjour Claire', 'texte saisi pendant la requête conservé');
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 2);
  assert.deepEqual([u.calls.saveDraft[1].input.text, u.calls.saveDraft[1].input.baseVersion], ['Bonjour Claire', 8]);
  hold.shift()();
  await tick(6);
  assert.equal(u.s().draftMeta[1].version, 9);
});

test('brouillon : conflit 409 garde le texte, aucune nouvelle écriture sans choix explicite', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.api.onSave = async () => { const e = new Error('Conflit'); e.status = 409; e.code = 'draft_conflict'; throw e; };
  u.c.act.draft({}, { target: { value: 'Mon texte' } });
  await u.runTimers();
  assert.equal(u.s().draftMeta[1].conflict, true);
  assert.equal(u.s().drafts[1], 'Mon texte');
  u.c.act.draft({}, { target: { value: 'Mon texte modifié' } });
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1, 'aucun écrasement automatique');
  // L'aperçu est refusé tant que le conflit n'est pas résolu.
  await u.c.act.sendPreview();
  assert.equal(u.calls.preview.length, 0);
  // Recharger la version serveur : texte local abandonné explicitement.
  u.api.onMessage = async id => ({ id, body: 'Corps', trail: [], draftVersion: 12, draft: { text: 'Texte d’un autre appareil', version: 12 } });
  await u.c.act.draftReload({ id: '1' });
  await tick(6);
  assert.equal(u.s().drafts[1], undefined);
  assert.deepEqual([u.s().draftMeta[1].version, u.s().draftMeta[1].savedText, u.s().draftMeta[1].conflict], [12, 'Texte d’un autre appareil', false]);
  // Garder son texte : nouvelle lecture de la version, puis remplacement explicite avec cette version.
  u.api.onSave = async (id, input) => ({ text: input.text, savedAt: 'x', version: input.baseVersion + 1 });
  u.c.act.draft({}, { target: { value: 'Ma version' } });
  u.s().draftMeta[1].conflict = true;
  u.api.onMessage = async id => ({ id, body: 'Corps', trail: [], draftVersion: 15, draft: { text: 'Autre', version: 15 } });
  await u.c.act.draftKeepMine({ id: '1' });
  await tick(6);
  assert.deepEqual([u.calls.saveDraft.at(-1).input.text, u.calls.saveDraft.at(-1).input.baseVersion], ['Ma version', 15]);
});

test('aperçu exact : brouillon enregistré d’abord, version transmise, jamais d’envoi automatique', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.compose({ mode: 'reply' });
  u.c.act.draft({}, { target: { value: 'Réponse vérifiée' } });
  await u.c.act.sendPreview();
  await tick(6);
  assert.equal(u.calls.saveDraft.length, 1);
  assert.deepEqual([u.calls.preview[0].input.text, u.calls.preview[0].input.baseVersion], ['Réponse vérifiée', 8]);
  assert.equal(u.s().confirm.preview.body, 'Réponse vérifiée');
  assert.equal(u.calls.send.length, 0, 'la validation reste une action distincte');
});

test('historique : messages plus anciens ajoutés sans doublon ; fil modifié rechargé', async () => {
  const u = await app();
  u.api.onMessage = async (id, params) => params?.before
    ? { id, body: 'Dernier', trail: [{ id: 'b', at: 2, body: 'B' }, { id: 'c', at: 1, body: 'C' }], history: { hasMore: false, nextCursor: null } }
    : { id, body: 'Dernier', trail: [{ id: 'a', at: 3, body: 'A' }, { id: 'b', at: 2, body: 'B' }], draftVersion: 1, history: { hasMore: true, nextCursor: 'h1' } };
  u.c.act.selectThread({ id: 2 });
  await tick(6);
  await u.c.act.loadOlder({ id: '2' });
  await tick(6);
  assert.deepEqual(plain(u.calls.message.find(m => m.params?.before).params), { limit: 50, before: 'h1' });
  assert.deepEqual(plain(u.s().details[2].trail.map(t => t.id)), ['a', 'b', 'c']);
  assert.equal(u.s().details[2].history.hasMore, false);
  // 409 history_changed : rechargement du fil, l'historique déjà affiché est conservé.
  u.s().details[2].history = { hasMore: true, nextCursor: 'h2' };
  u.api.onMessage = async (id, params) => {
    if (params?.before) { const e = new Error('changé'); e.status = 409; e.code = 'history_changed'; throw e; }
    return { id, body: 'Nouveau', trail: [{ id: 'n', at: 4, body: 'N' }, { id: 'a', at: 3, body: 'A' }], draftVersion: 1, history: { hasMore: true, nextCursor: 'h3' } };
  };
  await u.c.act.loadOlder({ id: '2' });
  await tick(8);
  assert.equal(u.s().details[2].body, 'Nouveau');
  assert.deepEqual(plain(u.s().details[2].trail.map(t => t.id)), ['n', 'a', 'b', 'c']);
});

test('mobile : un écran à la fois, retour navigateur et boutons cohérents', async () => {
  const u = await app({ mobile: true });
  assert.equal(u.s().mobile, true);
  assert.equal(u.s().selectedId, null, 'mobile : aucune lecture ouverte au démarrage');
  u.c.act.selectThread({ id: 2 });
  await tick();
  assert.equal(u.s().pane, 'reader');
  u.c.act.compose({ mode: 'reply' });
  assert.deepEqual(plain(u.pushed.map(p => p.relay)), ['reader', 'compose']);
  u.listeners.popstate(); // retour du téléphone : ferme seulement la rédaction
  assert.equal(u.s().composing, null);
  assert.equal(u.s().pane, 'reader');
  u.c.act.mobileBack(); // bouton « Retour » : passe par l'historique
  await tick();
  assert.equal(u.s().pane, 'list');
  u.c.act.openDrawer();
  assert.equal(u.s().drawer, true);
  u.c.act.selectNav({ id: 'todo' });
  await tick();
  assert.equal(u.s().drawer, false, 'choisir une vue ferme le tiroir');
  // Un envoi en cours n'est jamais annulé par le bouton retour.
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  await u.c.act.sendPreview();
  assert.equal(u.pushed.at(-1).relay, 'confirm');
  u.s().confirm.busy = true;
  u.listeners.popstate();
  assert.ok(u.s().confirm, 'envoi en cours conservé');
  assert.equal(u.pushed.at(-1).relay, 'confirm', 'couche remise dans l’historique');
  u.s().confirm.busy = false;
  u.listeners.popstate();
  assert.equal(u.s().confirm, null, 'aperçu fermé par retour hors envoi');
});

// ---------- Vues (public/js/views.js) ----------

const ctx = vm.createContext({ html, raw, when, cls, ICON: new Proxy({}, { get: (_, k) => (k === 'flag' ? () => '⚑' : '*') }), CH: { email: { label: 'Email', tint: '#eee', ink: '#111', mark: '@' }, whatsapp: { label: 'WhatsApp', tint: '#efe', ink: '#060', mark: 'W' } }, LABELS: {}, ACCOUNT_COLORS: {}, NAV: [['all', 'Boîte unifiée'], ['unread', 'Non lus'], ['todo', 'Avec drapeau'], ['drafts', 'Brouillons']], GROUPS: [], FREQ: [], SORTS: [], AV: [], TONES: [], STEPS: [], WINDOWS: [], CONTACT_CHANNELS: [] });
vm.runInContext(read('js/views.js').replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.app=(s,v)=>String(renderApp(s,v));', ctx);

function viewState(extra = {}) {
  const m = { id: 1, p: 'perso', accountId: 1, channel: 'email', from: 'Claire', initials: 'C', subject: 'Atelier', preview: 'p', handle: 'c@x.fr', account: 'Mail', sortAt: Date.UTC(2026, 9, 19, 8), count: 2 };
  const s = { app: 'mail', profileId: 'perso', nav: 'all', folder: null, channel: 'all', query: '', selectedId: 1, listW: 340, collapsed: {}, details: { 1: { body: 'Corps', trail: [{ from: 'Moi', initials: 'M', at: 1, body: 'Ancien' }], history: { hasMore: true, nextCursor: 'h' } } }, drafts: { 1: 'Brouillon' }, composeTo: {}, expandedTrail: {}, composing: 'reply', data: { profiles, folders: [], services: {}, ai: { configured: false } }, paged: true, page: { hasMore: true, loading: false, total: 30 }, draftMeta: { 1: { version: 4, savedText: 'Brouillon', savedAt: '2026-10-19T08:00:00.000Z' } }, ...extra };
  const v = { profile: profiles[0], inProfile: [m], byNav: [m], list: [m], sel: m, counts: { all: 30, unread: 4, todo: 2, drafts: 1, folders: {} }, channels: ['email'], folders: [], folderCount: () => 0, viewTitle: 'Boîte unifiée', contactsMine: [], showTriage: false };
  return [s, v];
}

test('vues : compteurs serveur, « Afficher plus », historique plus ancien, aperçu distinct de l’envoi', () => {
  const out = ctx.app(...viewState());
  assert.match(out, /30 messages, 4 non lus/);
  assert.match(out, /data-on-click="loadMore"/);
  assert.match(out, /data-on-click="loadOlder" data-id="1"/);
  assert.match(out, /data-on-click="sendPreview"[^>]*>Vérifier avant l’envoi/);
  assert.doesNotMatch(out, /data-on-click="confirmSend"/);
  assert.match(out, /Brouillon enregistré à/);
  assert.match(out, /grid-template-columns/, 'bureau : grille à trois colonnes inchangée');
  assert.doesNotMatch(out, /is-mobile/);
});

test('vues : état non enregistré et conflit explicites, envoi bloqué', () => {
  let [s, v] = viewState({ drafts: { 1: 'Brouillon modifié' } });
  assert.match(ctx.app(s, v), /Modifications non enregistrées/);
  [s, v] = viewState({ draftMeta: { 1: { version: 4, savedText: 'Brouillon', conflict: true } } });
  const out = ctx.app(s, v);
  assert.match(out, /modifié ailleurs/);
  assert.match(out, /data-on-click="draftReload"/);
  assert.match(out, /data-on-click="draftKeepMine"/);
  assert.match(out, /data-on-click="sendPreview"[^>]*disabled/);
  [s, v] = viewState({ offline: true });
  const offline = ctx.app(s, v);
  assert.match(offline, /Hors ligne : consultation seulement/);
  assert.match(offline, /data-on-click="sendPreview"[^>]*disabled/);
});

test('vues mobiles : écran unique, retour, tiroir et menu', () => {
  let [s, v] = viewState({ mobile: true, pane: 'reader' });
  let out = ctx.app(s, v);
  assert.match(out, /class="app is-mobile pane-reader"/);
  assert.doesNotMatch(out, /grid-template-columns/);
  assert.match(out, /data-on-click="mobileBack"/);
  assert.match(out, /data-on-click="openDrawer"/);
  assert.match(out, /<aside class="sidebar" aria-hidden="true">/);
  [s, v] = viewState({ mobile: true, pane: 'list', drawer: true });
  out = ctx.app(s, v);
  assert.match(out, /drawer-open/);
  assert.match(out, /class="drawer-backdrop" data-on-click="closeDrawer"/);
  assert.match(out, /aria-label="Fermer le menu"/);
});

// ---------- Feuille de style ----------

test('styles mobiles : écran ≤ 1000 px, 100dvh, zones sûres, cibles de 44 px, 16 px dans les champs', () => {
  const css = read('styles.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 1000px)'));
  // Même seuil côté CSS et côté application : téléphones en paysage (jusqu'à 932 px) et tablettes en portrait.
  const js = read('js/app.js');
  assert.equal((js.match(/matchMedia\?\.\('\(max-width: 1000px\)'\)/g) || []).length, 2);
  assert.doesNotMatch(css + js, /max-width: 760px/);
  assert.ok(mobile.length > 100);
  for (const needle of ['100dvh', 'env(safe-area-inset-bottom)', 'env(safe-area-inset-top)', 'width: 44px; height: 44px', 'min-height: 44px', 'font-size: 16px', '.is-mobile.pane-list > .reader { display: none; }', '.is-mobile.pane-reader > .list { display: none; }']) {
    assert.ok(mobile.includes(needle), needle);
  }
  const index = read('index.html');
  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /interactive-widget=resizes-content/);
});

// ---------- PWA : manifeste, icônes, service worker ----------

const pngSize = path => { const b = readFileSync(new URL(`../public${path}`, import.meta.url)); assert.equal(b.toString('latin1', 1, 4), 'PNG'); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; };

test('manifeste et icônes : application installable, icônes présentes aux tailles déclarées', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.deepEqual([m.start_url, m.scope, m.display, m.lang], ['/', '/', 'standalone', 'fr']);
  for (const icon of m.icons) {
    assert.ok(existsSync(new URL(`../public${icon.src}`, import.meta.url)), icon.src);
    if (icon.type === 'image/png') assert.equal(pngSize(icon.src), icon.sizes);
  }
  assert.ok(m.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.equal(pngSize('/icons/apple-touch-icon.png'), '180x180');
  for (const page of ['index.html', 'login.html']) assert.match(read(page), /<link rel="manifest" href="\/manifest.webmanifest">/);
});

function serviceWorker() {
  const handlers = {}, stores = new Map(), fetched = [];
  const cacheFor = name => { if (!stores.has(name)) stores.set(name, new Map()); const map = stores.get(name); return { put: async (k, v) => { map.set(typeof k === 'string' ? k : new URL(k.url).pathname, v); }, addAll: async reqs => { for (const r of reqs) map.set(new URL(r.url, 'https://relay.test').pathname, 'pre'); } }; };
  const sw = {
    self: { addEventListener: (t, fn) => { handlers[t] = fn; }, location: { origin: 'https://relay.test' }, clients: { claim: async () => {} } },
    caches: { open: async n => cacheFor(n), keys: async () => [...stores.keys()], delete: async n => stores.delete(n), match: async k => { for (const m of stores.values()) if (m.has(k)) return m.get(k); } },
    Request: class { constructor(url, init) { this.url = url; Object.assign(this, init); } }, URL, Response: { error: () => 'erreur' },
    fetch: async req => { fetched.push(req.url); return sw.next(req); }, next: async () => ({ ok: true, status: 200, type: 'basic', redirected: false, clone() { return 'copie'; } }),
  };
  vm.createContext(sw);
  vm.runInContext(read('sw.js') + '\nglobalThis.assets=ASSETS;globalThis.version=VERSION;', sw);
  const dispatch = async (type, request) => {
    let responded = null; const waits = [];
    handlers[type]({ request, respondWith: p => { responded = p; }, waitUntil: p => waits.push(p) });
    const res = responded && await responded;
    await Promise.all(waits);
    return { responded: !!responded, res };
  };
  const req = (path, extra = {}) => ({ url: `https://relay.test${path}`, method: 'GET', mode: 'cors', ...extra });
  return { sw, handlers, stores, fetched, dispatch, req };
}

test('service worker : liste blanche d’actifs, jamais API, auth, OAuth, QR ni mutation', async () => {
  const w = serviceWorker();
  for (const path of w.sw.assets) assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), path);
  assert.ok(!w.sw.assets.some(p => /^\/(api|auth|oauth)\b|^\/$|index\.html|login\.html/.test(p)), 'aucune page privée ni API dans les actifs');
  for (const path of ['/api/state?paged=1', '/api/messages/1', '/auth/session', '/oauth/google/callback?code=x', '/api/whatsapp/links/abc']) {
    assert.equal((await w.dispatch('fetch', w.req(path))).responded, false, path);
  }
  assert.equal((await w.dispatch('fetch', w.req('/api/messages/1/draft', { method: 'PUT' }))).responded, false);
  assert.equal((await w.dispatch('fetch', w.req('/styles.css?x=1'))).responded, false, 'variante avec requête : non gérée');
  assert.equal((await w.dispatch('fetch', { url: 'https://autre.test/styles.css', method: 'GET', mode: 'cors' })).responded, false);
  // Actif : réseau d'abord, mis en cache seulement si la réponse est complète et non redirigée.
  await w.dispatch('fetch', w.req('/js/app.js'));
  assert.equal(w.stores.get(w.sw.version).get('/js/app.js'), 'copie');
  w.sw.next = async () => ({ ok: true, status: 200, type: 'basic', redirected: true, clone() { return 'login'; } });
  await w.dispatch('fetch', w.req('/js/views.js'));
  assert.equal(w.stores.get(w.sw.version)?.get('/js/views.js'), undefined, 'redirection (page de connexion) jamais en cache');
  w.sw.next = async () => { throw new TypeError('hors ligne'); };
  assert.equal((await w.dispatch('fetch', w.req('/js/app.js'))).res, 'copie', 'hors ligne : actif depuis le cache');
  assert.equal((await w.dispatch('fetch', w.req('/js/api.js'))).res, 'erreur', 'actif absent du cache : erreur, rien d’inventé');
});

test('service worker : navigation hors ligne vers la page générique, anciennes versions supprimées', async () => {
  const w = serviceWorker();
  await w.dispatch('install');
  assert.ok(w.stores.get(w.sw.version).has('/offline.html'));
  w.sw.next = async () => { throw new TypeError('hors ligne'); };
  assert.equal((await w.dispatch('fetch', w.req('/', { mode: 'navigate' }))).res, 'pre');
  w.stores.set('relay-shell-ancienne', new Map());
  w.stores.set('autre-application', new Map());
  await w.dispatch('activate');
  assert.deepEqual([...w.stores.keys()].sort(), ['autre-application', w.sw.version].sort());
});

test('confidentialité : aucun contenu dans le stockage du navigateur', () => {
  for (const file of ['js/app.js', 'js/api.js', 'js/views.js', 'js/dom.js', 'js/constants.js', 'js/pwa.js', 'js/login.js', 'sw.js']) {
    const code = read(file);
    assert.doesNotMatch(code, /indexedDB|sessionStorage/, file);
    // Un seul point d'écriture, générique (préférences d'affichage), dans app.js.
    const writes = code.split('localStorage.setItem(').length - 1;
    assert.equal(writes, file === 'js/app.js' ? 1 : 0, file);
    if (writes) assert.ok(code.includes('localStorage.setItem(k, String(v))'), file);
  }
  // Seule clé locale : la largeur de colonne de la liste.
  assert.match(read('js/app.js'), /const LIST_W_KEY = 'relay\.listW';/);
  assert.equal((read('js/app.js').match(/storage\.set\(/g) || []).length, 2);
});

// ---------- Correctifs de revue : nouveau message, champs du brouillon, aperçu obsolète, hors ligne ----------

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const conflictError = () => Object.assign(new Error('Conflit'), { status: 409, code: 'draft_conflict' });
const field = (u, name, value) => u.c.act.newMailField({ field: name }, { target: { value } });

test('nouveau message : enregistrement automatique différé, une seule écriture en vol, version du serveur', async () => {
  const u = await app();
  u.c.act.newMessage();
  const hold = [];
  u.api.onSave = (id, input) => new Promise(r => hold.push(() => r({ savedAt: '2026-10-19T08:00:00.000Z', version: input.baseVersion + 1 })));
  field(u, 'to', 'claire@exemple.fr');
  field(u, 'text', 'Bonjour');
  assert.equal(u.calls.create.length, 0, 'rien avant le délai');
  await u.runTimers();
  assert.equal(u.calls.create.length, 1);
  assert.equal(u.calls.saveDraft.length, 1);
  assert.deepEqual(plain(u.calls.saveDraft[0]), { id: 50, input: { mode: 'new', to: 'claire@exemple.fr', cc: '', subject: '', text: 'Bonjour', baseVersion: 4 } }, 'version lue à la création, jamais supposée');
  // Saisie pendant la requête : champs actifs, texte conservé, aucune seconde écriture en vol.
  assert.equal(u.s().newMail.busy, false);
  field(u, 'text', 'Bonjour Claire');
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1);
  hold.shift()();
  await tick(6);
  assert.equal(u.s().newMail.version, 5);
  assert.equal(u.s().newMail.text, 'Bonjour Claire');
  assert.equal(u.s().newMail.saved.text, 'Bonjour', 'seul le texte envoyé est marqué enregistré');
  await u.runTimers();
  assert.equal(u.calls.create.length, 1, 'une seule création');
  assert.deepEqual([u.calls.saveDraft[1].input.text, u.calls.saveDraft[1].input.baseVersion], ['Bonjour Claire', 5]);
  hold.shift()();
  await tick(6);
  assert.equal(u.s().newMail.version, 6);
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 2, 'rien à enregistrer');
});

test('nouveau message : aucune écriture automatique après une erreur ou hors ligne', async () => {
  const u = await app();
  u.c.act.newMessage();
  u.api.onCreate = async () => { throw new Error('Serveur indisponible'); };
  field(u, 'text', 'Texte');
  await u.runTimers();
  assert.equal(u.s().newMail.saveError, 'Serveur indisponible');
  field(u, 'text', 'Texte suivant');
  await u.runTimers();
  assert.equal(u.calls.create.length, 1, 'pas de nouvel essai automatique');
  // Enregistrer explicitement relance l'écriture.
  u.api.onCreate = async () => ({ id: 50, draftVersion: 4 });
  await u.c.act.saveNewMail();
  await tick(6);
  assert.equal(u.calls.saveDraft.at(-1).input.text, 'Texte suivant');
  // Hors ligne : rien n'est envoyé, le texte reste local et non enregistré.
  u.s().offline = true;
  field(u, 'text', 'Hors ligne');
  await u.runTimers();
  await u.c.act.saveNewMail();
  await tick(6);
  assert.equal(u.calls.saveDraft.length, 1);
  assert.equal(u.s().newMail.text, 'Hors ligne');
  assert.notEqual(u.s().newMail.saved.text, 'Hors ligne');
  u.listeners.online?.();
  await tick(6);
  assert.equal(u.calls.saveDraft.length, 1, 'aucune reprise automatique au retour du réseau');
});

test('nouveau message : conflit résolu explicitement (Recharger / Garder ma version) avec la version relue', async () => {
  const u = await app();
  u.c.act.newMessage();
  u.api.onSave = async () => { throw conflictError(); };
  field(u, 'text', 'Mon texte');
  await u.runTimers();
  assert.equal(u.s().newMail.conflict, true);
  assert.equal(u.s().newMail.text, 'Mon texte');
  field(u, 'text', 'Mon texte modifié');
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1, 'aucun écrasement automatique');
  // Garder ma version : relecture, puis écriture conditionnelle sur la version relue.
  u.api.onMessage = async id => ({ id, accountId: 1, subject: 'Autre objet', draft: { text: 'Texte ailleurs', to: '', cc: '' }, draftVersion: 9 });
  u.api.onSave = async (id, input) => ({ savedAt: 'x', version: input.baseVersion + 1 });
  await u.c.act.newMailKeepMine();
  await tick(6);
  assert.deepEqual([u.calls.saveDraft.at(-1).input.text, u.calls.saveDraft.at(-1).input.baseVersion], ['Mon texte modifié', 9]);
  assert.deepEqual([u.s().newMail.conflict, u.s().newMail.version], [false, 10]);
  // Recharger : la version du serveur remplace le texte local, sans écriture.
  u.s().newMail.conflict = true;
  u.api.onMessage = async id => ({ id, accountId: 1, subject: 'Objet serveur', draft: { text: 'Texte serveur', to: 'a@b.fr', cc: '' }, draftVersion: 14 });
  const writes = u.calls.saveDraft.length;
  await u.c.act.newMailReload();
  await tick(6);
  assert.deepEqual([u.s().newMail.text, u.s().newMail.subject, u.s().newMail.version, u.s().newMail.conflict], ['Texte serveur', 'Objet serveur', 14, false]);
  assert.equal(u.calls.saveDraft.length, writes);
  // Retour de relecture après remplacement de la composition : ignoré.
  u.s().newMail.conflict = true;
  const late = deferred();
  u.api.onMessage = () => late.p;
  const pending = u.c.act.newMailKeepMine();
  const other = { ...u.s().newMail, cid: -1, text: 'Autre composition', conflict: false };
  u.s().newMail = other;
  late.resolve({ id: 50, accountId: 1, subject: 's', draft: { text: 'x' }, draftVersion: 20 });
  await pending;
  await tick(6);
  assert.equal(u.s().newMail, other);
  assert.equal(u.calls.saveDraft.length, writes);
});

test('nouveau message : retour d’écriture après fermeture appliqué à sa composition, version gardée à la reprise', async () => {
  const rows = [row(1), row(50, { kind: 'new' })];
  const u = await app({ state: page(rows) });
  u.c.act.newMessage();
  const save = deferred();
  u.api.onSave = () => save.p;
  field(u, 'text', 'Brouillon');
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1);
  u.c.act.closeNewMail();
  u.c.act.selectThread({ id: 1 });
  u.s().newMail = null; // composition remplacée (autre profil, autre compte…)
  save.resolve({ savedAt: 'x', version: 5 });
  await tick(6);
  assert.equal(u.s().newMail, null, 'rien n’est appliqué à une autre composition');
  u.c.act.selectThread({ id: 50 });
  await tick(6);
  assert.deepEqual([u.s().newMail.text, u.s().newMail.version, u.s().newMail.saved.text], ['Brouillon', 5, 'Brouillon'], 'reprise avec la version enregistrée, pas l’ancienne');
});

test('brouillon : un changement du seul destinataire ou du mode est enregistré et versionné', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.compose({ mode: 'forward' });
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 1, 'commencer un transfert sans texte est enregistré');
  assert.deepEqual(plain(u.calls.saveDraft[0].input), { text: '', mode: 'forward', to: '', baseVersion: 7 });
  u.c.act.composeTo({}, { target: { value: 'paul@exemple.fr' } });
  await u.runTimers();
  assert.equal(u.calls.saveDraft.length, 2);
  assert.deepEqual(plain(u.calls.saveDraft[1].input), { text: '', mode: 'forward', to: 'paul@exemple.fr', baseVersion: 8 });
  assert.equal(u.c.view().draftChanged, false);
  u.c.act.composeTo({}, { target: { value: 'lea@exemple.fr' } });
  assert.equal(u.c.view().draftChanged, true, 'destinataire seul : modification non enregistrée');
  u.c.act.saveDraft();
  await tick(6);
  assert.equal(u.calls.saveDraft.at(-1).input.to, 'lea@exemple.fr', 'le bouton Enregistrer l’écrit aussi');
  u.c.act.saveDraft();
  await tick(6);
  assert.equal(u.calls.saveDraft.length, 3, 'rien de nouveau, rien d’écrit');
  // Conflit détecté aussi sur le seul destinataire, puis Recharger reprend celui du serveur.
  u.c.act.composeTo({}, { target: { value: 'zoe@exemple.fr' } });
  u.api.onState = async () => page([row(1, { draftVersion: 30 }), row(2)]);
  u.api.onMessage = async id => ({ id, body: 'Corps', trail: [], draftVersion: 30, draft: { text: '', mode: 'forward', to: 'ailleurs@exemple.fr' } });
  await u.c.act.retryList();
  await tick(8);
  assert.equal(u.s().draftMeta[1].conflict, true);
  assert.equal(u.s().composeTo[1], 'zoe@exemple.fr');
  await u.c.act.draftReload({ id: '1' });
  assert.equal(u.s().composeTo[1], undefined);
  assert.equal(u.c.view().draftChanged, false);
});

test('aperçu : retour écarté si le brouillon change pendant l’attente ; envoi sans effacer un texte plus récent', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.compose({ mode: 'reply' });
  u.c.act.draft({}, { target: { value: 'Texte A' } });
  const wait = deferred();
  u.api.onPreview = () => wait.p;
  const pending = u.c.act.sendPreview();
  await tick(6);
  assert.equal(u.calls.preview.length, 1);
  u.c.act.draft({}, { target: { value: 'Texte B' } }); // frappe pendant la vérification
  wait.resolve({ from: 'a', to: ['b'], cc: [], subject: 's', body: 'Texte A', digest: 'd' });
  await pending;
  await tick(6);
  assert.equal(u.s().confirm, null, 'aperçu obsolète écarté');
  assert.equal(u.s().drafts[1], 'Texte B');
  // Aperçu valide puis frappe avant confirmation : l'envoi part avec A, B n'est jamais effacé.
  u.api.onPreview = async (id, input) => ({ from: 'a', to: ['b'], cc: [], subject: 's', body: input.text, digest: 'd' });
  u.c.act.draft({}, { target: { value: 'Texte A' } });
  await u.c.act.sendPreview();
  await tick(6);
  assert.equal(u.s().confirm.preview.body, 'Texte A');
  u.c.act.draft({}, { target: { value: 'Texte B' } });
  await u.c.act.confirmSend();
  await tick(6);
  assert.equal(u.calls.send.at(-1)[1].text, 'Texte A');
  assert.equal(u.s().drafts[1], 'Texte B', 'texte plus récent conservé');
  assert.equal(u.s().draftMeta[1].conflict,true,'une résolution explicite est requise après l’envoi');
});

test('aperçu : aussi écarté si la sélection change pendant l’attente', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.compose({ mode: 'reply' });
  u.c.act.draft({}, { target: { value: 'Texte A' } });
  const wait = deferred();
  u.api.onPreview = () => wait.p;
  const pending = u.c.act.sendPreview();
  await tick(6);
  u.c.act.selectThread({ id: 2 });
  wait.resolve({ from: 'a', to: ['b'], cc: [], subject: 's', body: 'Texte A', digest: 'd' });
  await pending;
  assert.equal(u.s().confirm, null);
});

test('hors ligne : aucun enregistrement de brouillon ni envoi, confirmation désactivée', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.compose({ mode: 'reply' });
  u.c.act.draft({}, { target: { value: 'Prêt' } });
  await u.c.act.sendPreview();
  await tick(6);
  assert.ok(u.s().confirm.preview);
  u.s().offline = true;
  await u.c.act.confirmSend();
  assert.equal(u.calls.send.length, 0, 'envoi refusé hors ligne');
  assert.match(u.s().confirm.error, /Hors ligne/);
  u.s().confirm = null;
  u.c.act.draft({}, { target: { value: 'Prêt, modifié hors ligne' } });
  await u.runTimers();
  u.c.act.saveDraft();
  await tick(6);
  assert.equal(u.calls.saveDraft.length, 1, 'aucune écriture hors ligne');
  assert.equal(u.c.view().draftChanged, true, 'reste non enregistré');
  await u.c.act.sendPreview();
  assert.equal(u.calls.preview.length, 1, 'pas de vérification hors ligne');
  const out = ctx.app({ ...viewState()[0], offline: true, confirm: { kind: 'send', messageId: 1, preview: { from: 'a', to: ['b'], cc: [], subject: 's', body: 'x' }, busy: false } }, viewState()[1]);
  assert.match(out, /data-on-click="confirmSend" disabled/);
});

test('mobile : Insérer depuis l’assistant ouvre la rédaction ; Retour ferme la rédaction et garde la lecture', async () => {
  const u = await app({ mobile: true });
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  u.c.act.aiDraft();
  u.s().ai = { ...u.s().ai, result: { text: 'Proposition' } };
  u.c.act.aiInsert();
  assert.equal(u.s().composing, 'reply');
  assert.equal(u.replaced.at(-1).relay, 'compose');
  u.listeners.popstate();
  assert.equal(u.s().composing, null);
  assert.equal(u.s().pane, 'reader');
  u.listeners.popstate();
  assert.equal(u.s().pane, 'list');
});

test('actualisation : même dernier message mais brouillon plus récent ailleurs', async () => {
  const u = await app();
  u.c.act.selectThread({ id: 1 });
  await tick(6);
  assert.equal(u.s().draftMeta[1].version, 7);
  // Brouillon propre : la version du serveur est reprise.
  u.api.onState = async () => page([row(1, { draftVersion: 8 }), row(2)]);
  u.api.onMessage = async id => ({ id, body: 'Corps', trail: [], draftVersion: 8, draft: { text: 'Écrit ailleurs', mode: 'reply' } });
  await u.c.act.retryList();
  await tick(8);
  assert.equal(u.s().details[1].draft.text, 'Écrit ailleurs');
  assert.deepEqual([u.s().draftMeta[1].version, u.s().draftMeta[1].conflict], [8, false]);
  // Brouillon local non enregistré : conservé, conflit signalé.
  u.c.act.draft({}, { target: { value: 'Mon texte' } });
  u.api.onState = async () => page([row(1, { draftVersion: 9 }), row(2)]);
  u.api.onMessage = async id => ({ id, body: 'Corps', trail: [], draftVersion: 9, draft: { text: 'Encore ailleurs', mode: 'reply' } });
  await u.c.act.retryList();
  await tick(8);
  assert.equal(u.s().drafts[1], 'Mon texte');
  assert.deepEqual([u.s().draftMeta[1].version, u.s().draftMeta[1].conflict], [8, true]);
});

test('vues : nouveau message en conflit avec Recharger / Garder ma version ; lecture seule pendant la vérification', () => {
  const [s, v] = viewState({ newMailOpen: true, newMail: { cid: 1, accountId: 1, messageId: 50, to: 'a@b.fr', cc: '', subject: 's', text: 'x', saved: { to: 'a@b.fr', cc: '', subject: 's', text: 'x' }, conflict: true } });
  const out = ctx.app(s, v);
  assert.match(out, /data-on-click="newMailReload"[^>]*>Recharger/);
  assert.match(out, /data-on-click="newMailKeepMine"[^>]*>Garder ma version/);
  assert.match(out, /data-on-click="previewNewMail" disabled/);
  const dirty = ctx.app({ ...s, newMail: { ...s.newMail, conflict: false, text: 'y' } }, v);
  assert.match(dirty, /Modifications non enregistrées/);
  const waiting = ctx.app(...viewState({ confirm: { kind: 'send', messageId: 1, busy: true, preview: null } }));
  assert.match(waiting, /data-key="draft-1" data-on-input="draft" readonly/);
});


test('vue de déconnexion : la confirmation reste accessible après les contrôles hors ligne',()=>{
 const out=ctx.app(...viewState({confirm:{kind:'disconnect',name:'Compte fictif',accountId:1,busy:false},offline:true}));
 assert.match(out,/Déconnecter Compte fictif/);assert.match(out,/data-on-click="confirmDisconnect"/);assert.doesNotMatch(out,/l’envoi reprendra/);
});


test('transfert : naviguer avant autosave conserve mode et destinataire',async()=>{
 const u=await app();u.c.act.selectThread({id:1});await tick(6);u.c.act.compose({mode:'forward'});u.c.act.composeTo({}, {target:{value:'paul@example.test'}});u.c.act.draft({}, {target:{value:'Transfert'}});u.c.act.selectThread({id:2});await tick(6);await u.runTimers();const save=u.calls.saveDraft.find(c=>c.id===1);assert.deepEqual(plain(save.input),{text:'Transfert',mode:'forward',to:'paul@example.test',baseVersion:7});
});

const twoProfiles=()=>[...profiles,{id:'other',name:'Autre',initials:'A',accounts:[{id:2,name:'Autre mail',channel:'email',svc:'gmail',perms:['read','drafts','send']}]}];
test('création différée : texte saisi avant identifiant conservé après remplacement de composition',async()=>{
 const data={...page([row(1),row(50,{kind:'new'})]),profiles:twoProfiles()},u=await app({state:data});u.api.onState=async()=>data;u.c.act.newMessage();const create=deferred();u.api.onCreate=()=>create.p;field(u,'text','A');await u.runTimers();field(u,'text','B plus récent');u.c.act.closeNewMail();u.c.act.selectProfile({id:'other'});await tick(6);u.c.act.newMessage();create.resolve({id:50,draftVersion:4});await tick(8);u.c.act.selectProfile({id:'perso'});await tick(6);await u.c.act.selectThread({id:50});await tick(6);assert.equal(u.s().newMail.text,'B plus récent');assert.equal(u.s().newMail.saved.text,'A');assert.equal(u.s().newMail.version,5);
});

test('autosave : composition B reprend lorsque l’écriture de A libère la file',async()=>{
 const data={...page([row(1),row(50,{kind:'new'})]),profiles:twoProfiles()},u=await app({state:data});u.api.onState=async()=>data;let id=50;u.api.onCreate=async()=>({id:id++,draftVersion:4});const first=deferred();u.api.onSave=(id,input)=>id===50?first.p:Promise.resolve({text:input.text,version:input.baseVersion+1,savedAt:'x'});u.c.act.newMessage();field(u,'text','A');await u.runTimers();assert.equal(u.calls.saveDraft.length,1);u.c.act.selectProfile({id:'other'});await tick(6);u.c.act.newMessage();field(u,'text','B');await u.runTimers();assert.equal(u.calls.saveDraft.length,1);first.resolve({text:'A',version:5,savedAt:'x'});await tick(8);await u.runTimers();assert.equal(u.calls.saveDraft.length,2);assert.equal(u.calls.saveDraft[1].input.text,'B');assert.equal(u.s().newMail.saved.text,'B');
});

test('brouillon existant : état enregistré repris sans écriture inutile',async()=>{
 const u=await app({state:page([row(50,{kind:'new'})])});u.api.onMessage=async id=>({id,accountId:1,subject:'Objet',draftVersion:8,draft:{text:'Déjà enregistré',to:'a@example.test',cc:'',savedAt:'x',synced:true}});await u.c.act.selectThread({id:50});await tick(6);assert.equal(u.s().newMail.saved.text,'Déjà enregistré');await u.c.act.saveNewMail();await tick(6);assert.equal(u.calls.saveDraft.length,0);
});


test('buffer plus récent après envoi : ne reprend jamais automatiquement la version distante pour l’écraser',async()=>{
 const u=await app();u.c.act.selectThread({id:1});await tick(6);u.c.act.compose({mode:'reply'});u.c.act.draft({}, {target:{value:'A validé'}});await u.c.act.sendPreview();u.c.act.draft({}, {target:{value:'B local plus récent'}});u.api.onState=async()=>page([row(1,{draftVersion:20}),row(2)]);u.api.onMessage=async id=>({id,body:'Corps',trail:[],draftVersion:20,draft:{text:'C distant',mode:'reply',version:20}});await u.c.act.confirmSend();await tick(8);await u.runTimers();assert.equal(u.s().drafts[1],'B local plus récent');assert.equal(u.s().draftMeta[1].conflict,true);assert.ok(!u.calls.saveDraft.some(c=>c.input.text==='B local plus récent'),'aucun écrasement automatique de C');await u.c.act.draftKeepMine({id:1});await tick(6);assert.equal(u.calls.saveDraft.at(-1).input.text,'B local plus récent');assert.equal(u.calls.saveDraft.at(-1).input.baseVersion,20,'reprise uniquement après choix explicite');
});

test('résolution nouveau message : les buffers nettoyés ne gardent pas une alerte de fermeture',async()=>{
 const u=await app();u.c.act.newMessage();u.api.onSave=async()=>{throw conflictError();};field(u,'text','Ancien');await u.runTimers();u.api.onMessage=async id=>({id,accountId:1,subject:'Objet serveur',draftVersion:10,draft:{text:'Texte serveur',to:'',cc:'',savedAt:'x'}});await u.c.act.newMailReload();let blocked=false;u.listeners.beforeunload({preventDefault(){blocked=true;}});assert.equal(blocked,false);
});
