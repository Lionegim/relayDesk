// Gabarits HTML (public/js/dom.js) : assemblage sans concaténations successives, texte et échappement inchangés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { html, raw, when, cls } from '../public/js/dom.js';

// Assemblage précédent (référence) : concaténations successives et join de tableaux.
class RefRaw { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => s.replace(/[&<>"']/g, c => ESC[c]);
const refStr = v => v instanceof RefRaw ? v.s : Array.isArray(v) ? v.map(refStr).join('') : v == null || v === false ? '' : esc(String(v));
function refHtml(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += refStr(v) + strings[i + 1]; });
  return new RefRaw(out);
}
const refRaw = s => new RefRaw(s);

test('valeurs simples : échappement, null/undefined/false vides, nombres et true conservés', () => {
  const out = String(html`<p title="${'"x" & \'y\''}">${'<b>'}${null}${undefined}${false}${0}${true}${''}${-1.5}</p>`);
  assert.equal(out, '<p title="&quot;x&quot; &amp; &#39;y&#39;">&lt;b&gt;0true-1.5</p>');
  assert.equal(String(html`${raw('<i>brut</i>')}`), '<i>brut</i>');
  assert.equal(String(html`a${[]}b`), 'ab');
  assert.equal(String(html``), '');
  assert.equal(String(html`${[['<', [raw('<br>'), null, [false, 'x']]], 1]}`), '&lt;<br>x1');
  assert.equal(String(html`${{ toString: () => '<o>' }}`), '&lt;o&gt;', 'objets convertis puis échappés');
  assert.equal(String(when(false, () => 'x')), '');
  assert.equal(cls('a', false, 'b', null), 'a b');
});

test('équivalence exacte avec l’assemblage précédent sur des structures imbriquées aléatoires', () => {
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const SAMPLES = ['', 'a', '<', '&amp;', '"', "'", 'é ✓ 😀', 'x'.repeat(300), '\n\t'];
  function value(depth, mk) {
    switch (rnd(depth > 4 ? 6 : 9)) {
      case 0: return null;
      case 1: return false;
      case 2: return rnd(1000) - 500;
      case 3: return SAMPLES[rnd(SAMPLES.length)];
      case 4: return mk.raw(`<i>${SAMPLES[rnd(SAMPLES.length)]}</i>`);
      case 5: return undefined;
      case 6: return Array.from({ length: rnd(5) }, () => value(depth + 1, mk));
      default: return template(depth + 1, mk);
    }
  }
  function template(depth, mk) {
    const n = rnd(6);
    const strings = Array.from({ length: n + 1 }, (_, i) => `<s${i} a="${depth}">`);
    return mk.html(strings, ...Array.from({ length: n }, () => value(depth, mk)));
  }
  for (let i = 0; i < 300; i++) {
    const start = seed;
    const ours = String(template(0, { html, raw }));
    seed = start;
    const ref = String(template(0, { html: refHtml, raw: refRaw }));
    assert.equal(ours, ref, `cas ${i}`);
  }
});

test('rendus complets des vues identiques à l’assemblage précédent (liste, lecture, compositeur, mobile)', () => {
  const load = dom => {
    const ctx = vm.createContext({ ...dom, ICON: new Proxy({}, { get: (_, k) => (k === 'flag' ? () => '⚑' : '*') }), CH: { email: { label: 'Email', tint: '#eee', ink: '#111', mark: '@' }, whatsapp: { label: 'WhatsApp', tint: '#efe', ink: '#060', mark: 'W' } }, LABELS: {}, ACCOUNT_COLORS: {}, NAV: [['all', 'Boîte unifiée'], ['unread', 'Non lus'], ['todo', 'Avec drapeau'], ['drafts', 'Brouillons']], GROUPS: [], FREQ: [], SORTS: [], AV: [], TONES: [], STEPS: [], WINDOWS: [], CONTACT_CHANNELS: [] });
    vm.runInContext(readFileSync(new URL('../public/js/views.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.app=(s,v)=>String(renderApp(s,v));', ctx);
    return ctx.app;
  };
  const ours = load({ html, raw, when, cls });
  const ref = load({ html: refHtml, raw: refRaw, when, cls });
  const profiles = [{ id: 'perso', name: 'Personnel', initials: 'P', accounts: [{ id: 1, name: 'Mail <perso>', channel: 'email', svc: 'gmail', perms: ['read', 'drafts', 'send'] }, { id: 2, name: 'WhatsApp', channel: 'whatsapp', svc: 'whatsapp', perms: ['read', 'send'] }] }];
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, p: 'perso', accountId: i % 7 ? 1 : 2, channel: i % 7 ? 'email' : 'whatsapp', from: `Claire & "Léa" ${i}`, initials: 'C', subject: `Atelier <${i}>`, preview: 'aperçu \'cité\'', handle: 'c@x.fr', account: 'Mail', sortAt: Date.UTC(2026, 9, 19, 8) - i * 60000, count: 2, unread: i % 3 === 0 }));
  const trail = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, from: 'Moi', initials: 'M', at: Date.UTC(2026, 9, 18) + i, body: `Ancien <${i}> & suite`, fromMe: i % 2 === 0 }));
  for (const sel of [rows[1], rows[0]]) for (const composing of [null, 'reply', 'forward']) for (const mobile of [false, true]) {
    const s = { app: 'mail', profileId: 'perso', nav: 'all', folder: null, channel: 'all', query: '', selectedId: sel.id, listW: 340, collapsed: {}, details: { [sel.id]: { body: 'Corps <script>x</script>', trail, history: { hasMore: true, nextCursor: 'h' } } }, drafts: { [sel.id]: 'Brouillon "à" <envoyer>' }, composeTo: { [sel.id]: 'a@b.fr' }, expandedTrail: {}, composing, data: { profiles, folders: [], services: {}, ai: { configured: false } }, paged: true, page: { hasMore: true, loading: false, total: 70 }, draftMeta: { [sel.id]: { version: 4, savedText: 'Brouillon' } }, mobile, pane: 'reader' };
    const v = { profile: profiles[0], inProfile: rows, byNav: rows, list: rows, sel, counts: { all: 70, unread: 17, todo: 2, drafts: 1, folders: {} }, channels: ['email', 'whatsapp'], folders: [], folderCount: () => 0, viewTitle: 'Boîte unifiée', contactsMine: [], showTriage: false };
    const out = ours(s, v);
    assert.ok(out.length > 20000);
    assert.equal(out, ref(s, v), `${sel.channel} ${composing} ${mobile}`);
    assert.doesNotMatch(out, /<script>/, 'contenu échappé');
  }
});

test('volumes : grands tableaux et imbrication profonde conservent le texte exact', () => {
  const items = Array.from({ length: 20000 }, (_, i) => html`<li data-id="${i}">${`<${i}>`}</li>`);
  assert.equal(String(html`<ul>${items}</ul>`), String(refHtml`<ul>${items.map(x => refRaw(x.s))}</ul>`));
  let deep = html`<b>fin</b>`, refDeep = refHtml`<b>fin</b>`;
  for (let i = 0; i < 3000; i++) { deep = html`<i>${deep}${[i, null]}</i>`; refDeep = refHtml`<i>${refDeep}${[i, null]}</i>`; }
  assert.equal(String(deep), String(refDeep));
});

test('a failed avatar stays hidden on live rerenders but a new source can load',()=>{
 const ctx=vm.createContext({document:{activeElement:null}});
 vm.runInContext(readFileSync(new URL('../public/js/dom.js',import.meta.url),'utf8').replace(/^export /gm,'')+'\nglobalThis.morph=morphNode;',ctx);
 function image(src,hidden=false){const a=new Map([['src',src],['class','wa-profile-photo']]);if(hidden)a.set('hidden','');return {nodeType:1,nodeName:'IMG',dataset:{},childNodes:[],get attributes(){return [...a].map(([name,value])=>({name,value}));},get hidden(){return a.has('hidden');},set hidden(v){if(v)a.set('hidden','');else a.delete('hidden');},matches:s=>s==='img.wa-profile-photo',getAttribute:k=>a.get(k)??null,hasAttribute:k=>a.has(k),setAttribute:(k,v)=>a.set(k,v),removeAttribute:k=>a.delete(k)};}
 const failed=image('/private-photo?scope=1',true);ctx.morph(failed,image('/private-photo?scope=1'));assert.equal(failed.hidden,true);
 ctx.morph(failed,image('/private-photo?scope=2'));assert.equal(failed.hidden,false);
});

test('live rerender preserves the accessibility association of an open contextual tooltip',()=>{
 const ctx=vm.createContext({document:{activeElement:null}});vm.runInContext(readFileSync(new URL('../public/js/dom.js',import.meta.url),'utf8').replace(/^export /gm,'')+'\nglobalThis.morph=morphNode;',ctx);
 function button(expanded){const a=new Map([['data-tooltip','Merge help'],['aria-expanded',expanded?'true':'false']]);if(expanded)a.set('aria-describedby','relay-context-help');return {nodeType:1,nodeName:'BUTTON',dataset:{},childNodes:[],get attributes(){return [...a].map(([name,value])=>({name,value}));},matches:s=>s==='[data-tooltip]',getAttribute:k=>a.get(k)??null,hasAttribute:k=>a.has(k),setAttribute:(k,v)=>a.set(k,v),removeAttribute:k=>a.delete(k)};}
 const trigger=button(true);ctx.morph(trigger,button(false));assert.equal(trigger.getAttribute('aria-expanded'),'true');assert.equal(trigger.getAttribute('aria-describedby'),'relay-context-help');
});
