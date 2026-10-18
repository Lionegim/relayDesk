// Gabarits HTML échappés par défaut, mise à jour du DOM par réconciliation et délégation d'événements.

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => s.replace(/[&<>"']/g, c => ESC[c]);
const str = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(str).join('') : v == null || v === false ? '' : esc(String(v));

export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += str(v) + strings[i + 1]; });
  return new Raw(out);
}

export const when = (cond, fn) => (cond ? fn() : '');
export const cls = (...xs) => xs.filter(Boolean).join(' ');

// Réconciliation minimale : garde les nœuds existants (et donc le focus, la sélection et le défilement).
const focused = new WeakSet();

export function patch(container, markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(markup);
  morphChildren(container, tpl.content);
  container.querySelectorAll('[data-autofocus]').forEach(el => {
    if (!focused.has(el)) { focused.add(el); el.focus(); }
  });
}

function morphChildren(cur, next) {
  const a = [...cur.childNodes], b = [...next.childNodes];
  b.forEach((n, i) => (i < a.length ? morphNode(a[i], n) : cur.appendChild(n)));
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

function morphNode(cur, next) {
  if (cur.nodeType !== next.nodeType || cur.nodeName !== next.nodeName || (cur.nodeType === 1 && cur.dataset.key !== next.dataset.key)) {
    cur.replaceWith(next);
    return;
  }
  if (cur.nodeType !== 1) {
    if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
    return;
  }
  for (const { name } of [...cur.attributes]) if (!next.hasAttribute(name)) cur.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (cur.getAttribute(name) !== value) cur.setAttribute(name, value);
  const editing = cur === document.activeElement;
  if (cur.nodeName === 'TEXTAREA') {
    if (!editing && cur.value !== next.value) cur.value = next.value;
    return;
  }
  if (cur.nodeName === 'INPUT') {
    const v = next.getAttribute('value') ?? '';
    if (!editing && cur.value !== v) cur.value = v;
    return;
  }
  morphChildren(cur, next);
}

// data-on-click="action", data-on-input="action", etc. Le premier ancêtre portant l'attribut gagne.
export function delegate(root, events, actions) {
  for (const [type, attr] of Object.entries(events)) {
    root.addEventListener(type, e => {
      const el = e.target.closest?.(`[data-on-${attr}]`);
      if (!el || !root.contains(el)) return;
      const fn = actions[el.getAttribute(`data-on-${attr}`)];
      if (fn) fn(el.dataset, e, el);
    });
  }
}
