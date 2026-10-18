import { html, raw, when, cls } from './dom.js';
import { CH, LABELS, ACCOUNT_COLORS, NAV, GROUPS, FREQ, SORTS, AV, TONES, STEPS, WINDOWS, CONTACT_CHANNELS, ICON } from './constants.js';

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const initialsOf = name => name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const timeOf = iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const icon = name => raw(ICON[name]);

export function renderApp(s, v) {
  const mail = s.app === 'mail';
  const cols = mail ? `220px min(${s.listW}px, max(280px, calc(100vw - 640px))) minmax(0,1fr)` : '220px minmax(0,1fr)';
  return html`
    <div class="${cls('app', v.compact && 'compact')}" style="grid-template-columns:${cols}">
      ${sidebar(s, v)}
      ${mail ? [messageList(s, v), reader(s, v)] : contactsPage(s, v)}
    </div>
    ${when(s.c, () => connectWizard(s))}
    ${when(s.toast, () => html`<div class="toast" role="status">${s.toast}</div>`)}`;
}

// ---------- Barre latérale ----------

function sidebar(s, v) {
  const unread = v.inProfile.filter(m => m.unread).length;
  const navCount = id => id === 'todo' ? v.inProfile.filter(m => m.flagged).length : id === 'drafts' ? v.inProfile.filter(m => m.draft).length : unread;
  const indent = d => `${6 + d * 14}px`;
  return html`
    <aside class="sidebar">
      <div class="profile-switch">
        <button class="side-item hov" data-on-click="toggleProfileMenu" aria-haspopup="menu" aria-expanded="${s.menu}">
          <span class="avatar" style="width:22px;height:22px;background:var(--neutral-200);color:var(--neutral-700);font-size:10px">${v.profile.initials}</span>
          <span class="grow ellipsis" style="font-weight:600">${v.profile.name}</span>
          <span class="muted" style="font-size:11px">⌄</span>
        </button>
        ${when(s.menu, () => html`
          <div class="menu" role="menu">
            ${s.data.profiles.map(p => html`
              <button class="${cls('side-item hov profile-option', p.id === s.profileId && 'is-current')}" role="menuitem" data-on-click="selectProfile" data-id="${p.id}">
                <span>${p.name}</span><span class="muted" style="font-size:11px">${p.kind}</span>
              </button>`)}
          </div>`)}
      </div>

      <div class="side-section">
        ${[['mail', 'Messages', unread, 'mail'], ['contacts', 'Contacts', v.contactsMine.length, 'people']].map(([app, label, n, ic]) => html`
          <button class="${cls('side-item', s.app === app && 'is-on')}" data-on-click="selectApp" data-app="${app}">
            <span class="ico neutral">${icon(ic)}</span><span class="grow">${label}</span>
            ${when(n, () => html`<span class="count">${n}</span>`)}
          </button>`)}
      </div>

      ${s.app === 'contacts' ? html`
        <div class="side-section">
          <div class="side-label">Groupes</div>
          ${GROUPS.map(([id, label]) => html`
            <button class="${cls('side-item', s.group === id && 'is-on')}" data-on-click="selectGroup" data-id="${id}">
              <span class="ico">${icon('list')}</span><span class="grow">${label}</span>
              <span class="count">${id === 'all' ? v.contactsMine.length : v.contactsMine.filter(c => c.g.includes(id)).length}</span>
            </button>`)}
        </div>` : html`
        <nav class="side-section">
          <div class="side-label">Favoris</div>
          ${NAV.map(([id, label]) => html`
            <button class="${cls('side-item', !s.folder && s.nav === id && 'is-on')}" data-on-click="selectNav" data-id="${id}">
              <span class="ico">${icon('mail')}</span><span class="grow">${label}</span>
              ${when(navCount(id), () => html`<span class="count">${navCount(id)}</span>`)}
            </button>`)}
        </nav>

        <div class="side-section">
          <div class="folders-head">
            <span class="side-label">Dossiers</span>
            <button class="folder-new" data-on-click="newRootFolder" title="Nouveau dossier">+</button>
          </div>
          ${v.folders.map(r => r.input ? html`
            <div class="folder-input" style="padding-left:${indent(r.depth + 1)}" data-key="folder-input">
              <input class="input input-sm" data-autofocus placeholder="${r.depth ? 'Nom du sous-dossier' : 'Nom du dossier'}" value="${s.folderDraft}"
                data-on-input="folderDraft" data-on-keydown="folderKey" data-on-blur="folderBlur" maxlength="80">
            </div>` : folderRow(s, v, r, indent))}
        </div>`}

      <div class="side-section">
        <div class="side-label">Comptes</div>
        ${v.profile.accounts.map(a => html`
          <button class="side-item hov" data-on-click="openAccount" data-name="${a.name}" title="${a.status}">
            <span class="acct-mark" style="background:${CH[a.channel].tint};color:${CH[a.channel].ink}">${CH[a.channel].mark}</span>
            <span class="grow ellipsis">${a.name}</span>
            <span class="acct-dot" style="background:${ACCOUNT_COLORS[a.c] || ACCOUNT_COLORS.muted}"></span>
          </button>`)}
        <button class="side-item hov side-add" data-on-click="openConnect">
          <span class="mark" style="width:18px;height:18px;font-size:15px;font-weight:400">+</span><span class="ellipsis">Ajouter un canal</span>
        </button>
      </div>
    </aside>`;
}

function folderRow(s, v, r, indent) {
  const f = r.f, n = v.folderCount(f.id);
  return html`
    <div class="${cls('folder-row', s.folder === f.id && 'is-on', s.dragOver === f.id && 'is-drop')}" style="padding-left:${indent(r.depth)}" data-key="${f.id}"
      data-on-dragover="folderDragOver" data-on-dragleave="folderDragLeave" data-on-drop="folderDrop" data-id="${f.id}">
      <button class="${cls('folder-caret', !s.collapsed[f.id] && 'is-open', !r.kids && 'is-leaf')}" data-on-click="toggleFolder" data-id="${f.id}" aria-label="Déplier">▶</button>
      <button class="folder-name" data-on-click="selectFolder" data-id="${f.id}">
        <span class="ico">${icon('folder')}</span>
        <span class="grow ellipsis">${f.name}</span>
        ${when(n, () => html`<span class="count muted" style="font-size:12px">${n}</span>`)}
      </button>
      <button class="folder-sub" data-on-click="addSubfolder" data-id="${f.id}" title="Nouveau sous-dossier">+</button>
    </div>`;
}

// ---------- Liste des messages ----------

function messageList(s, v) {
  const chans = ['all', ...Object.keys(CH).filter(c => v.byNav.some(m => m.channel === c))];
  return html`
    <section class="list">
      <div class="${cls('resizer', s.resizing && 'is-active')}" data-on-pointerdown="startResize" data-on-dblclick="resetWidth" title="Glisser pour redimensionner"></div>
      <header class="list-head">
        <div class="list-title">
          <div class="grow" style="display:flex;flex-direction:column;min-width:0">
            <strong class="ellipsis">${v.viewTitle} — ${v.profile.name}</strong>
            <small>${v.inProfile.length} messages, ${v.inProfile.filter(m => m.unread).length} non lus</small>
          </div>
          <button class="icon-btn" title="Filtrer">${icon('lines')}</button>
        </div>
        <input class="input" placeholder="Rechercher" value="${s.query}" data-on-input="search" style="font-size:14px">
        <div class="chips">
          ${chans.map(c => html`<button class="${cls('chip', s.channel === c && 'is-on')}" data-on-click="selectChannel" data-id="${c}">${c === 'all' ? 'Tous' : CH[c].label}</button>`)}
        </div>
      </header>
      <div class="threads">
        ${v.list.map(m => html`
          <button class="${cls('thread', m.id === s.selectedId && 'is-on')}" draggable="true" data-key="m${m.id}" data-id="${m.id}"
            data-on-click="selectThread" data-on-dragstart="threadDragStart">
            ${when(m.unread, () => html`<span class="dot"></span>`)}
            <span class="avatar">${m.initials}</span>
            <span class="thread-body">
              <span class="thread-line">
                <span class="thread-from ellipsis">${m.from}</span>
                ${when(m.flagged, () => html`<span class="thread-flag">⚑</span>`)}
                <span class="thread-time">${m.time}</span>
              </span>
              <span class="thread-subject"><span class="grow ellipsis">${m.subject}</span><span class="thread-channel">${CH[m.channel].label}</span></span>
              <span class="thread-preview">${m.preview}</span>
            </span>
          </button>`)}
        ${when(!v.list.length, () => html`<div class="empty">Aucun message</div>`)}
      </div>
    </section>`;
}

// ---------- Lecture ----------

function reader(s, v) {
  const sel = v.sel;
  const folderTargets = [{ f: { id: '', name: 'Aucun dossier' }, depth: 0 }, ...v.folders.filter(r => !r.input)];
  return html`
    <main class="reader">
      <div class="toolbar">
        <button class="icon-btn" title="Nouveau message">${icon('compose')}</button>
        <div class="grow"></div>
        <div class="icon-group">
          <button class="icon-btn" data-on-click="compose" data-mode="reply" title="Répondre">${icon('reply')}</button>
          <button class="icon-btn" data-on-click="compose" data-mode="replyAll" title="Répondre à tous">${icon('replyAll')}</button>
          <button class="icon-btn" data-on-click="compose" data-mode="forward" title="Transférer">${icon('forward')}</button>
        </div>
        <div class="icon-group">
          <button class="icon-btn" data-on-click="archive" title="Archiver">${icon('archive')}</button>
          <button class="icon-btn" data-on-click="toggleRead" title="${sel?.unread ? 'Marquer lu' : 'Marquer non lu'}">${icon('mail')}</button>
        </div>
        <div class="icon-group">
          <button class="icon-btn" data-on-click="toggleMove" title="Déplacer" aria-haspopup="menu" aria-expanded="${s.moveOpen}">${icon('folder')}</button>
          <button class="icon-btn" data-on-click="toggleFlag" title="Drapeau">${raw(ICON.flag(!!sel?.flagged))}</button>
          ${when(s.moveOpen, () => html`
            <div class="menu" role="menu">
              ${folderTargets.map(r => html`
                <button class="${cls('move-target', (sel?.folderId ?? '') === r.f.id && 'is-on')}" role="menuitem" data-on-click="moveTo" data-id="${r.f.id}"
                  style="padding-left:${6 + (r.depth + 0.3) * 14}px">${r.f.name}</button>`)}
            </div>`)}
        </div>
        <div class="grow"></div>
      </div>
      ${sel ? messageView(s, v, sel) : html`<div class="no-selection">Aucun message sélectionné</div>`}
      ${when(s.ai && sel, () => aiPanel(s, sel))}
    </main>`;
}

function messageView(s, v, sel) {
  const trail = sel.trail || [];
  const folderName = s.data.folders.find(f => f.id === sel.folderId)?.name || 'Boîte de réception';
  const composeLabel = { reply: `Répondre à ${sel.from}`, replyAll: 'Répondre à tous', forward: `Transférer : ${sel.subject}` }[s.composing];
  const draft = s.drafts[sel.id] ?? sel.draft?.text ?? '';
  return html`
    <div class="reader-scroll">
      <div class="reader-top">
        <span>${plural(trail.length + 1, 'message')}</span>
        <button class="link-btn" data-on-click="aiSummary">${icon('sparkle')}Résumer</button>
      </div>
      <div class="msg-head">
        <span class="avatar">${sel.initials}</span>
        <div class="msg-meta">
          <span style="font-size:14px;font-weight:700">${sel.from}</span>
          <span style="font-size:13px">${sel.subject}</span>
          <span class="muted" style="font-size:12px">${sel.handle} → ${sel.account}</span>
        </div>
        <div class="msg-side"><span>${folderName} · ${sel.account}</span><span>${sel.time}</span></div>
      </div>
      ${when(v.showTriage, () => html`
        <div class="triage">
          <span class="badge badge-${LABELS[sel.label] || 'secondary'}">${sel.label}</span>
          <span class="grow ellipsis" style="min-width:0">${sel.triage}</span>
        </div>`)}
      <div class="msg-body">${sel.body}</div>
      ${when(trail.length, () => html`
        <div style="display:flex;flex-direction:column">
          ${[...trail].reverse().map((t, i) => {
            const key = `${sel.id}:${i}`;
            return html`
              <button class="${cls('trail-item', s.expandedTrail[key] && 'is-open')}" data-on-click="toggleTrail" data-trail="${key}">
                <span class="avatar">${t.initials}</span>
                <span style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
                  <span style="display:flex;gap:8px;font-size:13px"><b style="font-weight:600">${t.from}</b><span class="muted" style="margin-left:auto;font-size:12px">${t.time}</span></span>
                  <span class="trail-text">${s.expandedTrail[key] ? t.body : t.body.replace(/\n/g, ' ')}</span>
                </span>
              </button>`;
          })}
        </div>`)}
      ${when(s.composing, () => html`
        <div class="composer">
          <div class="composer-head">
            <span class="grow">${composeLabel}</span>
            <button class="composer-close" data-on-click="closeComposer" aria-label="Fermer">×</button>
          </div>
          <textarea data-autofocus data-key="draft-${sel.id}" data-on-input="draft" placeholder="Répondre à ${sel.from.split(' ')[0]} depuis ${sel.account}…">${draft}</textarea>
          <div class="composer-foot">
            <button class="btn btn-ghost" data-on-click="aiDraft">✳ Aider à rédiger</button>
            <span class="composer-status ellipsis">${sel.draft ? `Brouillon enregistré à ${timeOf(sel.draft.savedAt)}` : 'Brouillon local'}</span>
            <button class="btn btn-ghost" data-on-click="saveDraft">Enregistrer</button>
            <button class="btn btn-brand" disabled title="L’envoi nécessite un compte connecté et ta validation">Envoyer</button>
          </div>
        </div>`)}
    </div>`;
}

function aiPanel(s, sel) {
  const ai = s.ai, draftMode = ai.mode === 'draft';
  const result = ai.forId === sel.id ? ai.result : null;
  const n = (sel.trail || []).length + 1;
  return html`
    <div class="ai" role="dialog" aria-label="Assistant">
      <div class="ai-head">
        <span class="ai-logo">✳</span>
        <span style="display:flex;flex-direction:column;flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">Assistant</span>
          <span class="muted ellipsis" style="font-size:12px">${sel.subject} · ${plural(n, 'message')}</span>
        </span>
        <button class="close-btn" data-on-click="aiClose" aria-label="Fermer">×</button>
      </div>
      <div class="ai-tabs">
        ${[['summary', 'Résumer le fil'], ['draft', 'Rédiger une réponse']].map(([mode, label]) => html`
          <button class="${cls('ai-tab', ai.mode === mode && 'is-on')}" data-on-click="aiTab" data-mode="${mode}">${label}</button>`)}
      </div>
      <div class="ai-body">
        ${when(draftMode, () => html`
          <label class="field">
            <span class="field-label">Intention</span>
            <textarea data-on-input="aiIntent" maxlength="500" placeholder="Ex : valider, demander une dernière relecture du titre">${s.aiIntent}</textarea>
          </label>
          <div class="field">
            <span class="field-label">Ton</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${TONES.map(t => html`<button class="${cls('pill', t === s.aiTone && 'is-on')}" data-on-click="aiTone" data-tone="${t}">${t}</button>`)}
            </div>
          </div>`)}
        ${when(ai.loading, () => html`
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="skeleton" style="width:100%"></div><div class="skeleton" style="width:91.6%"></div><div class="skeleton" style="width:75%"></div>
          </div>`)}
        ${when(ai.error, () => html`<div class="alert">${ai.error}</div>`)}
        ${when(result, () => html`<div class="ai-result">${result}</div>`)}
      </div>
      <div class="ai-foot">
        ${when(result, () => html`<button class="btn btn-ghost" data-on-click="aiRun">Régénérer</button>`)}
        <div class="grow"></div>
        ${when(draftMode && result, () => html`<button class="btn btn-brand" data-on-click="aiInsert">Insérer dans la réponse</button>`)}
        ${when(!result, () => html`
          <button class="btn btn-brand" data-on-click="aiRun" ${raw(ai.loading ? 'disabled' : '')}>
            ${when(ai.loading, () => html`<span class="spinner"></span>`)}${ai.mode === 'summary' ? 'Résumer' : 'Générer'}
          </button>`)}
      </div>
    </div>`;
}

// ---------- Contacts ----------

function contactsPage(s, v) {
  const all = v.contacts.length > 0 && v.picked.length === v.contacts.length;
  const sortLabel = SORTS.find(x => x[0] === s.sort)[1];
  const searchOpen = s.contactSearch || !!s.contactQuery;
  return html`
    <main class="contacts">
      <div class="contacts-scroll">
        <div class="contacts-head">
          <div style="display:flex;flex-direction:column;gap:4px">
            <h1>${v.groupTitle}</h1>
            <span class="muted" style="font-size:13px">${plural(v.contacts.length, 'contact')}</span>
          </div>
          <button class="btn btn-brand">+ Ajouter un contact</button>
        </div>

        <div class="contacts-tools">
          <div class="group-tabs">
            ${GROUPS.map(([id, label]) => html`
              <button class="${cls('group-tab', s.group === id && 'is-on')}" data-on-click="selectGroup" data-id="${id}">${icon('list')}${label}</button>`)}
          </div>
          <div class="contacts-actions">
            ${when(searchOpen, () => html`
              <div style="width:180px"><input class="input" data-autofocus placeholder="Rechercher un contact" value="${s.contactQuery}" data-on-input="contactQuery"></div>`)}
            <button class="icon-btn" title="Filtrer">${icon('funnel')}</button>
            <button class="icon-btn" data-on-click="cycleSort" title="${sortLabel}">${icon('sort')}</button>
            <button class="icon-btn" data-on-click="toggleContactSearch" title="Rechercher">${icon('search')}</button>
          </div>
        </div>

        ${when(v.picked.length, () => html`
          <div class="picked-bar">
            <span style="font-weight:600;white-space:nowrap">${v.picked.length} sélectionné${v.picked.length > 1 ? 's' : ''}</span>
            <div class="grow"></div>
            <button class="btn btn-ghost" data-on-click="mailPicked">Voir les messages</button>
            <button class="btn btn-ghost" data-on-click="clearPicked">Désélectionner</button>
          </div>`)}

        <div class="table">
          <div class="trow">
            <div class="cell-check">${checkbox(all, 'toggleAll', '', 'Tout sélectionner')}</div>
            <span class="th">Nom</span><span class="th">Titre</span><span class="th">Fréquence</span><span class="th">Canaux</span><span class="th" style="text-align:right">Dernier échange</span>
          </div>
          ${v.contacts.map(c => {
            const [avBg, avFg] = AV[c.name.length % AV.length];
            return html`
              <div class="${cls('trow body', s.picked[c.id] && 'is-picked', s.focusId === c.id && 'is-focus')}" data-key="${c.id}" data-on-click="focusContact" data-id="${c.id}">
                <div class="cell-check">${checkbox(!!s.picked[c.id], 'pickContact', c.id, `Sélectionner ${c.name}`)}</div>
                <div class="cell-name"><span class="avatar" style="background:${avBg};color:${avFg}">${initialsOf(c.name)}</span><span class="ellipsis">${c.name}</span></div>
                <span class="cell-title ellipsis" style="color:${c.title ? 'var(--foreground)' : 'var(--muted-foreground)'}">${c.title || 'Ajouter un titre…'}</span>
                <div style="padding:0 12px"><button class="${cls('freq', c.freq && 'is-set')}" data-on-click="cycleFreq" data-id="${c.id}">${FREQ[c.freq]}</button></div>
                <div class="cell-channels">
                  ${CONTACT_CHANNELS.map(k => {
                    const has = c.ch.includes(k);
                    return html`<span class="ch-mark" title="${CH[k].label}" style="background:${has ? CH[k].tint : 'var(--muted)'};color:${has ? CH[k].ink : 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)'}">${CH[k].mark}</span>`;
                  })}
                </div>
                <span class="cell-last">${c.last}</span>
              </div>`;
          })}
          ${when(!v.contacts.length, () => html`<div class="empty">Aucun contact</div>`)}
        </div>
      </div>
    </main>`;
}

const checkbox = (on, action, id, label) => html`
  <button class="checkbox" role="checkbox" aria-checked="${on}" aria-label="${label}" data-on-click="${action}" data-id="${id}">${when(on, () => icon('check'))}</button>`;

// ---------- Assistant de connexion ----------

function connectWizard(s) {
  const c = s.c, d = c.svc ? s.data.services[c.svc] : null;
  const PERM = s.data.permissions;
  const si = c.step === 'done' ? 3 : STEPS.findIndex(x => x[0] === c.step);
  const permsOn = d ? d.perms.filter(k => c.perms[k]) : [];
  const missing = d?.auth === 'fields' && d.fields.some(f => !f[5] && !String(c.fields[f[0]] || '').trim());
  const msgs = Math.round(c.win * 6.4);
  const profileName = id => s.data.profiles.find(p => p.id === id).name;
  const next = { config: 'Continuer', auth: d?.btn, done: 'Ouvrir la boîte' }[c.step];
  const nextDisabled = c.step === 'auth' ? missing : c.step === 'config' ? !c.name.trim() : false;
  const checks = [['Autorisation reçue', 1, ''], ['Capacités vérifiées', 20, `${permsOn.length} accès`], [`Import des ${c.win} derniers jours`, 100, `${Math.round(msgs * c.progress / 100)} / ${msgs}`], ['Triage local', 100, '']];
  const barColor = p => p === 100 ? 'var(--success)' : p >= 75 ? 'var(--primary)' : p >= 50 ? 'var(--warning)' : p >= 25 ? 'var(--status-high)' : 'var(--destructive)';

  return html`
    <div class="overlay" data-on-click="closeConnect">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Ajouter un canal" data-on-click="noop">
        <div class="dialog-steps">
          ${STEPS.map(([, label], i) => {
            const done = i < si || c.step === 'done', on = i === si && c.step !== 'done';
            return html`<div class="${cls('step', done && 'is-done', on && 'is-on')}"><span class="step-n">${done ? '✓' : i + 1}</span><span>${label}</span></div>`;
          })}
          <button class="close-btn" data-on-click="closeConnect" aria-label="Fermer">×</button>
        </div>

        <div class="dialog-body">
          ${when(c.step === 'pick', () => html`
            <h3>Ajouter un canal</h3>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${Object.entries(s.data.services).map(([k, sv]) => html`
                <button class="service" data-on-click="pickService" data-svc="${k}" ${raw(sv.disabled ? 'disabled' : '')}>
                  <span class="service-mark" style="background:${CH[sv.ch].tint};color:${CH[sv.ch].ink}">${CH[sv.ch].mark}</span>
                  <span style="display:flex;flex-direction:column;gap:2px;flex:1">
                    <span style="font-size:14px;font-weight:600">${sv.name}</span>
                    <span class="muted" style="font-size:12px">${sv.note}</span>
                  </span>
                  ${when(sv.state, () => html`<span class="badge badge-outline">${sv.state}</span>`)}
                  <span class="muted">›</span>
                </button>`)}
            </div>`)}

          ${when(d && c.step !== 'pick', () => html`
            <div class="svc-head">
              <span class="service-mark" style="background:${CH[d.ch].tint};color:${CH[d.ch].ink}">${CH[d.ch].mark}</span>
              <div style="display:flex;flex-direction:column;gap:2px">
                <h3>${d.name}</h3>
                <span class="muted" style="font-size:13px">${c.step === 'done' ? `Connecté au profil ${profileName(c.profile)}` : d.note}</span>
              </div>
            </div>`)}

          ${when(c.step === 'config', () => html`
            <div class="field" style="gap:8px">
              <span class="field-label">Profil de destination</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                ${s.data.profiles.map(p => html`<button class="${cls('pill', p.id === c.profile && 'is-on')}" data-on-click="cProfile" data-id="${p.id}">${p.name}</button>`)}
              </div>
            </div>
            <label class="field" style="gap:8px">
              <span class="field-label">Nom du compte</span>
              <input class="input" value="${c.name}" data-on-input="cName" maxlength="80">
            </label>
            <div class="field" style="gap:8px">
              <span class="field-label">Permissions</span>
              <div class="perms">
                ${d.perms.map(k => html`
                  <div class="perm">
                    <span style="display:flex;flex-direction:column;gap:2px;flex:1">
                      <span style="font-size:13px;font-weight:600">${PERM[k][0]}</span>
                      <span class="muted" style="font-size:12px">${PERM[k][1]}</span>
                    </span>
                    <button class="switch" role="switch" aria-checked="${!!c.perms[k]}" aria-label="${PERM[k][0]}" data-on-click="cPerm" data-perm="${k}" ${raw(k === 'read' ? 'disabled' : '')}></button>
                  </div>`)}
              </div>
            </div>
            <div class="field" style="gap:8px">
              <span class="field-label">Historique à importer</span>
              <div style="display:flex;gap:6px">
                ${WINDOWS.map(w => html`<button class="${cls('pill', w === c.win && 'is-on')}" data-on-click="cWindow" data-win="${w}">${w} jours</button>`)}
              </div>
            </div>`)}

          ${when(c.step === 'auth', () => html`
            <div class="recap">
              <span class="muted">Profil</span><span style="font-weight:600">${profileName(c.profile)}</span>
              <span class="muted">Compte</span><span style="font-weight:600">${c.name}</span>
              <span class="muted">Accès</span><span style="font-weight:600">${permsOn.map(k => PERM[k][0]).join(', ')}</span>
              <span class="muted">Historique</span><span style="font-weight:600">${c.win} derniers jours</span>
            </div>
            ${when(d.auth === 'oauth', () => html`
              <div class="field" style="gap:8px">
                <span class="field-label">Autorisations demandées à ${d.provider}</span>
                ${permsOn.filter(k => d.scopes[k]).map(k => html`
                  <div class="scope"><span style="color:var(--success);font-weight:700">✓</span><span>${d.scopes[k][0]}</span><code>${d.scopes[k][1]}</code></div>`)}
              </div>`)}
            ${when(d.auth === 'fields', () => html`
              <div class="fields">
                ${d.fields.map(f => html`
                  <label class="field" style="grid-column:${f[6] ? '1 / -1' : 'auto'}">
                    <span class="field-label">${f[1]}</span>
                    <input class="input" type="${f[4] || 'text'}" value="${c.fields[f[0]] ?? ''}" placeholder="${f[3] || ''}" data-on-input="cField" data-field="${f[0]}" ${raw(f[5] ? 'readonly' : '')} autocomplete="off">
                  </label>`)}
              </div>`)}
            ${when(c.error, () => html`<div class="alert">${c.error}</div>`)}`)}

          ${when(c.step === 'sync', () => html`
            <div style="display:flex;flex-direction:column;gap:12px">
              ${checks.map(([label, at, meta], i) => {
                const done = c.progress >= at && (i < 2 || c.progress >= 100);
                const live = !done && (i === 0 || c.progress >= checks[i - 1][1]);
                return html`
                  <div class="${cls('check-row', done && 'is-done', (done || live) && 'is-live')}">
                    <span class="check-icon">${done ? '✓' : live ? '…' : ''}</span>
                    <span class="grow">${label}</span>
                    <span class="muted" style="font-size:12px">${meta}</span>
                  </div>`;
              })}
            </div>
            <div class="progress" role="progressbar" aria-valuenow="${c.progress}" aria-valuemin="0" aria-valuemax="100">
              <div style="width:${c.progress}%;background:${barColor(c.progress)}"></div>
            </div>`)}

          ${when(c.step === 'done', () => html`
            <div class="stats">
              ${[[msgs, 'messages importés'], [Math.round(msgs / 3.2), 'conversations'], [Math.round(msgs / 22), 'à traiter']].map(([n, label]) => html`
                <div class="stat"><strong>${n}</strong><span class="muted" style="font-size:12px">${label}</span></div>`)}
            </div>`)}
        </div>

        <div class="dialog-foot">
          ${when((c.step === 'config' && !c.fromAccount) || c.step === 'auth', () => html`<button class="btn btn-ghost" data-on-click="cBack">Retour</button>`)}
          <div class="grow"></div>
          ${when(next, () => html`<button class="btn btn-brand" data-on-click="cNext" ${raw(nextDisabled ? 'disabled' : '')}>${next}</button>`)}
        </div>
      </div>
    </div>`;
}
