// Interface mobile et PWA : liste paginée, historique, brouillons versionnés, navigation mobile, service worker.
// Exécution en machine virtuelle avec une API simulée : aucun réseau, aucune donnée réelle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { html, raw, when, cls } from '../public/js/dom.js';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
// Les objets créés dans la machine virtuelle n'ont pas les prototypes de ce contexte : comparaison en JSON.
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------- Application (public/js/app.js) avec API, minuteries et historique simulés ----------

const profiles = [{ id: 'perso', name: 'Personnel', initials: 'P', accounts: [{ id: 1, name: 'Mail', channel: 'email', svc: 'gmail', perms: ['read', 'drafts', 'send'] }] }];
const row = (id, extra = {}) => ({ id, p: 'perso', accountId: 1, channel: 'email', from: `Exp ${id}`, subject: `Objet ${id}`, preview: '', sortAt: 1000 - id, count: 1, draftVersion: 3, ...extra });
const page = (messages, extra = {}) => ({ profiles, folders: [], contacts: [], services: {}, messages, page: { limit: 50, total: messages.length, hasMore: false, nextCursor: null, ...extra }, counts: { all: 9, unread: 2, todo: 1, drafts: 0, folders: {} } });

async function app({ mobile = false, state: first } = {}) {
  const calls = { state: [], message: [], saveDraft: [], preview: [], send: [] }, timers = [], listeners = {}, pushed = [];
  const api = {
    session: async () => ({ enabled: false }),
    state: params => { calls.state.push(params); return api.onState(params); },
    onState: async () => first || page([row(1), row(2)]),
    message: (id, params) => { calls.message.push({ id, params }); return api.onMessage(id, params); },
    onMessage: async id => ({ id, body: 'Corps', trail: [], draftVersion: 7, draft: null, history: { hasMore: false, nextCursor: null } }),
    saveDraft: (id, input) => { calls.saveDraft.push({ id, input }); return api.onSave(id, input); },
    onSave: async (id, input) => ({ text: input.text, savedAt: '2026-10-19T08:00:00.000Z', version: input.baseVersion + 1 }),
    previewSend: (id, input) => { calls.preview.push({ id, input }); return Promise.resolve({ from: 'a', to: ['b'], cc: [], subject: 's', body: input.text, digest: 'd' }); },
    send: (...a) => { calls.send.push(a); return Promise.resolve({ sent: true }); },
    updateMessage: async () => ({}),
  };
  const history = { pushState: s => pushed.push(s), replaceState: () => {}, back: () => setImmediate(() => listeners.popstate?.()) };
  const c = {
    api, patch: () => {}, delegate: () => {}, renderApp: () => '', NAV: [['all', 'Boîte'], ['unread', 'Non lus'], ['todo', 'Avec drapeau'], ['drafts', 'Brouillons']], GROUPS: [['all', 'Tous']], SETTINGS: {}, WINDOWS: [7, 30, 90],
    localStorage: { getItem: () => null, setItem: () => {} }, document: { getElementById: () => ({ querySelector: () => null }), addEventListener: () => {} },
    queueMicrotask, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: n => { if (timers[n - 1]) timers[n - 1].fn = null; },
    setInterval: () => 1, clearInterval: () => {}, URLSearchParams, location: { search: '', replace: () => {} }, history, console,
    matchMedia: () => ({ matches: mobile, addEventListener: () => {} }), addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  vm.createContext(c);
  vm.runInContext(read('js/app.js').replace(/^import .*;\n/gm, '') + '\nglobalThis.inspect=()=>state;globalThis.act=actions;globalThis.view=()=>derive(state);', c);
  await tick(6);
  const runTimers = async () => { const due = timers.splice(0).filter(t => t.fn); for (const t of due) t.fn(); await tick(6); };
  return { c, api, calls, timers, runTimers, listeners, pushed, s: () => c.inspect() };
}

test('liste paginée : filtres serveur, compteurs serveur, réponse obsolète ignorée', async () => {
  const u = await app();
  assert.equal(u.s().paged, true);
  assert.deepEqual(plain(u.calls.state[0]), { paged: 1, profile: 'anove', nav: 'all', channel: 'all', limit: 50 });
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

test('styles mobiles : écran ≤ 760 px, 100dvh, zones sûres, cibles de 44 px, 16 px dans les champs', () => {
  const css = read('styles.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
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
