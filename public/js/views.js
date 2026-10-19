import {networkView} from './network.js';
import { html, raw, when, cls } from './dom.js';
import { CH, LABELS, ACCOUNT_COLORS, NAV, GROUPS, FREQ, SORTS, AV, TONES, STEPS, WINDOWS, CONTACT_CHANNELS, ICON } from './constants.js';

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const initialsOf = name => name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const timeOf = iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DAY = 86400000;
// Libellé façon Apple Mail : heure aujourd'hui, « Hier », jour de la semaine, puis date.
function whenLabel(ms) {
  const d = new Date(ms), today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return timeOf(ms);
  if (d >= today - DAY) return 'Hier';
  if (d >= today - 6 * DAY) { const w = d.toLocaleDateString('fr-FR', { weekday: 'short' }); return w[0].toUpperCase() + w.slice(1); }
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const timeLabel = m => m.time ?? whenLabel(m.sortAt ?? m.at);
const icon = name => raw(ICON[name]);
const SOCIAL_BRANDS = {
  instagram: { icon: '/icons/instagram-glyph-black.svg', label: 'Instagram' },
  linkedin: { icon: '/icons/linkedin-in-blue.png', label: 'LinkedIn' },
};
const socialMark = channel => html`<img class="social-brand-icon" src="${SOCIAL_BRANDS[channel].icon}" width="32" height="32" alt="" aria-hidden="true">`;
const channelMark = channel => channel === 'whatsapp'
  ? html`<img class="wa-brand-glyph" src="/icons/whatsapp-glyph-green.svg" width="24" height="24" alt="" aria-hidden="true">`
  : SOCIAL_BRANDS[channel] ? socialMark(channel) : CH[channel].mark;
// Marques officielles : le fournisseur identifie le compte, le canal reste générique.
const PROVIDER_BRANDS = {
  gmail: { icon: '/icons/gmail.webp', label: 'Gmail' },
  outlook: { icon: '/icons/outlook.svg', label: 'Microsoft Outlook / Microsoft 365' },
};
const providerMark = (svc, channel) => PROVIDER_BRANDS[svc]
  ? html`<img class="provider-brand-icon" src="${PROVIDER_BRANDS[svc].icon}" width="24" height="24" alt="" aria-hidden="true">`
  : channelMark(channel);
const providerBadge = account => {
  const brand = PROVIDER_BRANDS[account?.svc] || SOCIAL_BRANDS[account?.channel];
  return when(brand, () => html`<span class="provider-badge">${providerMark(account.svc, account.channel)}<span>${brand.label}</span></span>`);
};

export function renderApp(s, v) {
  const mail = s.app === 'mail', mobile = !!s.mobile;
  const cols = mail ? `220px min(${s.listW}px, max(280px, calc(100vw - 640px))) minmax(0,1fr)` : '220px minmax(0,1fr)';
  // Mobile : un seul écran (liste ou lecture), barre latérale en tiroir ; la grille vient alors de la feuille de style.
  return html`
    ${when(s.offline, () => html`<div class="offline-banner" role="status">Hors ligne : consultation seulement. Rien n’est mis en attente ni envoyé plus tard.</div>`)}
    <div class="${cls('app', mail && 'mail-workspace', v.compact && 'compact', mobile && 'is-mobile', mobile && `pane-${mail ? s.pane || 'list' : 'list'}`, mobile && s.drawer && 'drawer-open')}" ${raw(mobile ? '' : `style="grid-template-columns:${cols}"`)}>
      ${sidebar(s, v)}
      ${when(mobile && s.drawer, () => html`<div class="drawer-backdrop" data-on-click="closeDrawer" aria-hidden="true"></div>`)}
      ${mail ? [messageList(s, v), reader(s, v)] : s.app==='duplicates'?duplicatesPage(s,v):s.app==='history'?contactHistoryPage(s,v):s.app==='settings'?mailSettingsPage(s,v):contactsPage(s, v)}
    </div>
    ${when(s.newMailOpen, () => newMailDialog(s, v))}
    ${when(s.c, () => connectWizard(s))}
    ${when(s.confirm?.kind === 'disconnect', () => disconnectDialog(s.confirm))}
    ${when(s.confirm?.kind === 'send' && s.confirm.preview, () => sendDialog(s.confirm, s.offline))}
    ${when(s.authPanel, () => authDevices(s))}
    ${when(s.contactImport, () => contactImportDialog(s,v))}
    ${when(s.personOpen, () => personDialog(s,v))}${when(s.groupEditor,()=>groupDialog(s,v))}${when(s.mailSettingsPreview,()=>historyWindowReview(s))}
    ${when(s.toast, () => html`<div class="${cls('toast', s.toastOk && 'toast-ok')}" role="status">${s.toast}</div>`)}`;
}

// ---------- Barre latérale ----------

function sidebar(s, v) {
  const counts = v.counts || { unread: v.inProfile.filter(m => m.unread).length, todo: v.inProfile.filter(m => m.flagged).length, drafts: v.inProfile.filter(m => m.draft).length };
  const unread = counts.unread;
  const navCount = id => id === 'todo' ? counts.todo : id === 'drafts' ? counts.drafts : id === 'all' ? counts.unread : counts.unread;
  const indent = d => `${6 + Math.min(d,4) * 16}px`;
  return html`
    <aside class="sidebar" ${raw(s.mobile ? `aria-hidden="${!s.drawer}"` : '')}>
      ${when(s.mobile, () => html`<button class="close-btn drawer-close" data-on-click="closeDrawer" aria-label="Fermer le menu">×</button>`)}
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
          <button class="${cls('side-item', (s.app === app || app==='contacts' && ['duplicates','history'].includes(s.app)) && 'is-on')}" data-on-click="selectApp" data-app="${app}">
            <span class="ico neutral">${icon(ic)}</span><span class="grow">${label}</span>
            ${when(n, () => html`<span class="count">${n}</span>`)}
          </button>`)}
      </div>

      ${['contacts','duplicates','history'].includes(s.app) ? html`
        <div class="side-section">
          <button class="${cls('side-item',s.app==='duplicates' && 'is-on')}" data-on-click="selectApp" data-app="duplicates"><span class="ico">${icon('people')}</span><span class="grow">Doublons à vérifier</span></button>
          <button class="${cls('side-item',s.app==='history' && 'is-on')}" data-on-click="selectApp" data-app="history"><span class="ico">${icon('list')}</span><span class="grow">Liens et fusions</span></button><div class="folders-head"><div class="side-label">Groupes</div><button class="folder-new" data-on-click="openGroup" title="Créer un groupe" aria-label="Créer un groupe">+</button></div>
          ${(v.groups || GROUPS).map(([id, label]) => html`
            <button class="${cls('side-item', s.group === id && 'is-on')}" data-on-click="selectGroup" data-id="${id}">
              <span class="ico">${icon('list')}</span><span class="grow">${label}</span>
              <span class="count">${id === 'all' ? v.contactsMine.length : v.contactsMine.filter(c => c.g.includes(id) || (s.data.personGroups || []).find(g=>g.id===id)?.members.includes(c.id)).length}</span>
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
            ${when(s.profileId!=='all',()=>html`<button class="folder-new" data-on-click="newRootFolder" title="Nouveau dossier">+</button>`)}
          </div>
          ${[...new Set(v.folders.filter(r=>!r.input).map(r=>r.f.accountId || 'local'))].map(accountId=>{
            const account=v.profile.accounts.find(a=>a.id===accountId),key='account:'+accountId;
            return html`<div class="mailbox-account"><button class="mailbox-account-title" data-on-click="toggleFolder" data-id="${key}" aria-expanded="${!s.collapsed[key]}"><span>${s.collapsed[key]?'▸':'▾'}</span>${account?providerMark(account.svc,account.channel):icon('folder')}<strong class="ellipsis">${account?.name || 'Dossiers locaux'}</strong></button>
            ${when(!s.collapsed[key],()=>v.folders.filter(r=>!r.input && (r.f.accountId || 'local')===accountId).map(r=>folderRow(s,v,r,indent)))}</div>`;
          })}
          ${v.folders.filter(r=>r.input).map(r=>html`<div class="folder-input" style="padding-left:${indent(r.depth+1)}"><input class="input input-sm" data-autofocus placeholder="Nom du dossier" value="${s.folderDraft}" data-on-input="folderDraft" data-on-keydown="folderKey" data-on-blur="folderBlur" maxlength="80"></div>`)}
        </div>`}

      <div class="side-section">
        <div class="side-label">Comptes</div>
        ${v.profile.accounts.map(a => html`
          <div style="position:relative">
          <button class="side-item hov" data-on-click="openAccount" data-id="${a.id}" data-name="${a.name}" title="${a.status}">
            <span class="acct-mark" style="background:${CH[a.channel].tint};color:${CH[a.channel].ink}">${providerMark(a.svc, a.channel)}</span>
            <span class="grow ellipsis">${a.name}${a.profileName?` · ${a.profileName}`:''}</span>
            <span class="acct-dot" style="background:${ACCOUNT_COLORS[a.c] || ACCOUNT_COLORS.muted}"></span>
          </button>
          ${when(s.data.services[a.svc]?.real && s.accountMenu === a.id, () => html`
            <div class="menu" role="menu" aria-label="Compte de messagerie" style="left:0;right:0;top:100%">
              <button class="side-item hov" role="menuitem" data-on-click="accountSync" data-id="${a.id}">Synchroniser maintenant</button>
              ${when(['gmail','outlook'].includes(a.svc),()=>html`<button class="side-item hov" role="menuitem" data-on-click="openMailSettings">Historique et stockage</button><button class="side-item hov" role="menuitem" data-on-click="accountHistory" data-id="${a.id}" data-action="${['running','retrying'].includes(a.history?.status)?'pause':'start'}">${['running','retrying'].includes(a.history?.status)?'Mettre l’import en pause':a.history?.status==='paused'?'Reprendre l’import choisi':a.history?.status==='complete'?'Historique choisi importé':'Importer l’historique choisi'}</button>`)}
              <button class="side-item hov" role="menuitem" data-on-click="accountPermissions" data-id="${a.id}">${a.svc === 'whatsapp' ? 'Relier l’appareil' : 'Modifier les permissions'}</button>
              <button class="side-item hov" role="menuitem" data-on-click="disconnectAccount" data-id="${a.id}" style="color:var(--destructive)">Déconnecter</button>
            </div>`)}
          </div>`)}
        <button class="side-item hov side-add" data-on-click="openConnect">
          <span class="mark" style="width:18px;height:18px;font-size:15px;font-weight:400">+</span><span class="ellipsis">Ajouter un canal</span>
        </button>
      </div>
      <div class="side-section"><button class="side-item hov" data-on-click="openMailSettings"><span class="ico">${icon('lines')}</span><span>Paramètres</span></button></div>
      ${when(s.auth?.enabled, () => html`<div class="side-section auth-controls">
        <button class="side-item hov" data-on-click="authDevices">Appareils connectés</button>
        <button class="side-item hov" data-on-click="authLogout">Se déconnecter</button>
      </div>`)}
    </aside>`;
}

function folderRow(s, v, r, indent) {
  const f = r.f, n = v.folderCount(f.id),closed=s.collapsed[f.id] ?? !!r.kids;
  return html`
    <div class="${cls('folder-row', s.folder === f.id && 'is-on', s.dragOver === f.id && 'is-drop')}" style="padding-left:${indent(r.depth)}" data-key="${f.id}"
      data-on-dragover="folderDragOver" data-on-dragleave="folderDragLeave" data-on-drop="folderDrop" data-id="${f.id}">
      <button class="${cls('folder-caret', !closed && 'is-open', !r.kids && 'is-leaf')}" data-on-click="toggleFolder" data-id="${f.id}" aria-label="${closed?'Déplier':'Replier'} ${f.name}" aria-expanded="${!closed}" ${raw(!r.kids?'disabled':'')}>▶</button>
      <button class="folder-name" data-on-click="selectFolder" data-id="${f.id}">
        <span class="ico">${icon('folder')}</span>
        <span class="grow ellipsis">${f.name}</span>
        ${when(n, () => html`<span class="count muted" style="font-size:12px" title="Conversations non lues, sous-dossiers compris">${n}</span>`)}
      </button>
      <button class="folder-sub" ${raw(s.profileId==='all'?'disabled':'')} data-on-click="addSubfolder" data-id="${f.id}" title="Nouveau sous-dossier">+</button>
    </div>`;
}

// ---------- Liste des messages ----------

function messageList(s, v) {
  const present = v.channels || [...new Set(v.byNav.map(m => m.channel))];
  const chans = ['all', ...Object.keys(CH).filter(c => present.includes(c))];
  const counts = v.counts || { all: v.inProfile.length, unread: v.inProfile.filter(m => m.unread).length };
  const page = s.paged ? s.page : null;
  return html`
    <section class="list" aria-label="Messages">
      <div class="${cls('resizer', s.resizing && 'is-active')}" data-on-pointerdown="startResize" data-on-dblclick="resetWidth" title="Glisser pour redimensionner"></div>
      <header class="list-head">
        <div class="list-title">
          ${when(s.mobile, () => html`<button class="icon-btn mobile-only" data-on-click="openDrawer" aria-label="Ouvrir le menu" aria-expanded="${!!s.drawer}">${icon('lines')}</button>`)}
          <div class="grow" style="display:flex;flex-direction:column;min-width:0">
            <span class="inbox-eyebrow">${v.profile.name}</span><strong class="ellipsis inbox-heading">${s.channel === 'whatsapp' ? 'WhatsApp' : v.viewTitle}</strong>
            <small>${s.channel === 'whatsapp' ? plural(page ? page.total ?? v.list.length : v.list.length, 'conversation') : `${counts.all} messages, ${counts.unread} non lus`}</small>
          </div>
          ${s.mobile ? html`<button class="icon-btn mobile-only" data-on-click="newMessage" aria-label="Nouveau message">${icon('compose')}</button>` : html`<button class="icon-btn" title="Filtrer">${icon('lines')}</button>`}
        </div>
        <input class="input" type="search" placeholder="Rechercher" value="${s.query}" data-on-input="search" aria-label="Rechercher dans les messages" style="font-size:14px">
        <div class="chips">
          ${chans.map(c => html`<button class="${cls('chip', s.channel === c && 'is-on')}" data-on-click="selectChannel" data-id="${c}">${c === 'all' ? 'Tous' : CH[c].label}</button>`)}
        </div>
        ${when(['all','email'].includes(s.channel),()=>html`<div class="mail-history-list">${v.profile.accounts.filter(a=>a.history).map(a=>html`
          <section class="${cls('mail-history',a.history.status==='complete' && 'is-complete')}" aria-label="Import historique ${a.name}" data-key="history-${a.id}">
            <div><strong>${providerMark(a.svc,a.channel)} ${a.name}</strong><span>${a.history.status==='complete'?'Historique importé':a.history.status==='paused'?'Import en pause':a.history.status==='retrying'?'Reprise automatique prévue':'Import en arrière-plan'}</span></div>
            <p>${plural(a.history.done,'conversation')} traitées${a.history.enumerated?` sur ${a.history.discovered}`:' · recherche de l’historique…'}</p>
            ${when(a.history.enumerated,()=>html`<progress max="${Math.max(1,a.history.discovered)}" value="${a.history.status==='complete' && !a.history.discovered?1:a.history.done}" aria-label="Progression ${a.name}"></progress>`)}
            ${when(a.history.error,()=>html`<p class="muted">${a.history.error}</p>`)}
            ${when(a.history.status!=='complete',()=>html`<button class="link-btn" data-on-click="accountHistory" data-id="${a.id}" data-action="${a.history.status==='paused'?'start':'pause'}" ${raw(s.offline?'disabled':'')}>${a.history.status==='paused'?'Reprendre':'Mettre en pause'}</button>`)}
          </section>`)}</div>`)}
        ${when(s.channel === 'whatsapp', () => html`<div class="wa-sync" role="status">
          ${v.profile.accounts.filter(a => a.svc === 'whatsapp').map(a => html`<div>
            <strong>${a.name} · 7 derniers jours</strong>
            <span>${a.sync?.status === 'syncing' ? a.sync?.history?.mode === 'chats' ? 'Complément des conversations connues depuis le téléphone…' : 'Récupération de l’historique depuis le téléphone…' : a.sync?.error || 'Historique reçu de WhatsApp'}</span>
            ${when(a.sync?.status === 'syncing' && a.sync?.history?.reason, () => html`<span>${a.sync.history.reason}</span>`)}
            <span>${plural(a.sync?.threads ?? 0, 'conversation')} · ${plural(a.sync?.messages ?? 0, 'message')}</span>
            <button class="link-btn" data-on-click="accountSync" data-id="${a.id}" ${raw(a.sync?.status === 'syncing' ? 'disabled' : '')}>Actualiser l’historique</button>
          </div>`)}
        </div>`)}
      </header>
      <div class="threads">
        ${v.list.map(m => html`
          <button class="${cls('thread', m.channel === 'whatsapp' && 'thread-wa', m.unread && 'is-unread', m.id === s.selectedId && 'is-on')}" draggable="true" data-key="m${m.id}" data-id="${m.id}"
            data-on-click="selectThread" data-on-dragstart="threadDragStart">
            ${when(m.unread, () => html`<span class="dot"></span>`)}
            <span class="avatar">${m.initials}</span>
            <span class="thread-body">
              <span class="thread-line">
                <span class="thread-from ellipsis">${m.channel === 'whatsapp' ? waName(m) : m.from}</span>
                ${when(m.flagged, () => html`<span class="thread-flag">⚑</span>`)}
                <span class="thread-time">${timeLabel(m)}</span>
              </span>
              ${when(m.channel !== 'whatsapp', () => html`<span class="thread-subject"><span class="grow ellipsis">${m.subject}</span><span class="thread-channel">${CH[m.channel].label}</span></span>`)}
              <span class="thread-preview">${when(s.profileId==='all',()=>html`<strong>${s.data.profiles.find(p=>p.id===m.p)?.name} · ${m.account}</strong> · `)}${m.preview}</span>
            </span>
          </button>`)}
        ${when(!v.list.length && !page?.loading, () => html`<div class="empty">Aucun message</div>`)}
        ${when(page?.error, () => html`<div class="list-more"><span class="muted">Liste non actualisée : ${page.error}</span><button class="btn btn-ghost" data-on-click="retryList">Réessayer</button></div>`)}
        ${when(page?.hasMore && !page?.error, () => html`<div class="list-more"><button class="btn btn-ghost" data-on-click="loadMore" ${raw(page.loading ? 'disabled' : '')}>${when(page.loading === 'more', () => html`<span class="spinner"></span>`)}Afficher plus</button></div>`)}
        ${when(page?.loading === true && !v.list.length, () => html`<div class="empty"><span class="spinner"></span> Chargement…</div>`)}
      </div>
    </section>`;
}

// ---------- Lecture ----------

function reader(s, v) {
  const sel = v.sel;
  const folderTargets = [{ f: { id: '', name: 'Aucun dossier' }, depth: 0 }, ...(v.allFolders || v.folders).filter(r => !r.input && (s.profileId!=='all' || r.f.p===sel?.p))];
  return html`
    <main class="reader">
      <div class="toolbar">
        ${s.mobile ? html`<button class="btn btn-ghost mobile-back" data-on-click="mobileBack" aria-label="Retour à la liste">‹ Retour</button>` : html`<button class="icon-btn" data-on-click="newMessage" title="Nouveau message">${icon('compose')}</button>`}
        <div class="grow"></div>
        <div class="icon-group">
          <button class="icon-btn" data-on-click="compose" data-mode="reply" title="Répondre">${icon('reply')}</button>
          <button class="icon-btn" data-on-click="compose" data-mode="replyAll" title="Répondre à tous" ${raw(sel?.channel === 'whatsapp' ? 'disabled' : '')}>${icon('replyAll')}</button>
          <button class="icon-btn" data-on-click="compose" data-mode="forward" title="Transférer" ${raw(sel?.channel === 'whatsapp' ? 'disabled' : '')}>${icon('forward')}</button>
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
      ${sel ? (sel.channel === 'whatsapp' ? whatsappView(s, v, sel) : messageView(s, v, sel)) : html`<div class="no-selection">Aucun message sélectionné</div>`}
      ${when(s.ai && sel && s.ai.forId === sel.id, () => aiPanel(s, sel))}
    </main>`;
}

// État du brouillon enregistré sur le serveur : jamais « enregistré » tant que le texte affiché ne l'est pas.
function draftState(s, v, id, text) {
  const meta = (s.draftMeta || {})[id];
  if (!meta) return null;
  if (meta.conflict) return { tone: 'error', label: 'Conflit : brouillon modifié sur un autre appareil' };
  if (meta.saving) return { tone: 'muted', label: 'Enregistrement…' };
  if (meta.error) return { tone: 'error', label: `Non enregistré : ${meta.error}` };
  if (v.draftChanged ?? text !== (meta.savedText ?? '')) return { tone: 'warn', label: 'Modifications non enregistrées' };
  if (meta.savedAt) return { tone: 'muted', label: `Brouillon enregistré à ${timeOf(meta.savedAt)}` };
  return { tone: 'muted', label: 'Brouillon' };
}
function draftConflict(s, id) {
  if (!(s.draftMeta || {})[id]?.conflict) return '';
  return html`<div class="draft-conflict" role="alert">
    <p>Ce brouillon a été modifié ailleurs. Ton texte est conservé ici et n’a pas été enregistré.</p>
    <div><button class="btn btn-ghost" data-on-click="draftReload" data-id="${id}">Charger la version enregistrée</button>
    <button class="btn btn-ghost" data-on-click="draftKeepMine" data-id="${id}">Remplacer par mon texte</button></div>
  </div>`;
}
function olderButton(s, full, id) {
  if (!full?.history?.hasMore) return '';
  const busy = (s.historyLoading || {})[id];
  return html`<div class="history-more"><button class="btn btn-ghost" data-on-click="loadOlder" data-id="${id}" ${raw(busy ? 'disabled' : '')}>${when(busy, () => html`<span class="spinner"></span>`)}Afficher les messages plus anciens</button></div>`;
}

function messageView(s, v, sel) {
  const full = s.details[sel.id];
  const account = v.profile.accounts.find(a => a.id === sel.accountId);
  const trail = full?.trail || [];
  const folderName = s.data.folders.find(f => f.id === sel.folderId)?.name || 'Boîte de réception';
  const composeLabel = { reply: `Répondre à ${sel.from}`, replyAll: 'Répondre à tous', forward: `Transférer : ${sel.subject}` }[s.composing];
  const draft = s.drafts[sel.id] ?? full?.draft?.text ?? '';
  return html`
    <div class="reader-scroll">
      <div class="reader-top">
        <span>${plural(sel.count || 1, 'message')}</span>
        <div style="display:flex;gap:12px"><button class="link-btn" data-on-click="aiClassify">Classer</button><button class="link-btn" data-on-click="aiSummary">${icon('sparkle')}Résumer</button></div>
      </div>
      <h1 class="mail-subject">${sel.subject || 'Sans objet'}</h1><div class="msg-head">
        <span class="avatar">${sel.initials}</span>
        <div class="msg-meta">
          <strong class="mail-sender">${sel.from}</strong><span class="mail-address">${sel.handle}</span>
        </div>
        <div class="msg-side">${providerBadge(account)}<span class="mail-source">${s.data.profiles.find(p=>p.id===sel.p)?.name || v.profile.name} · ${account?.address || sel.account}</span><span class="mail-location">${folderName}</span><time>${timeLabel(sel)}</time></div>
      </div>
      ${when(v.showTriage, () => html`
        <div class="triage">
          <span class="badge badge-${LABELS[sel.label] || 'secondary'}">${sel.label}</span>
          <span class="grow ellipsis" style="min-width:0">${sel.triage}</span>
        </div>`)}
      ${full ? html`<div class="mail-reading-controls"><span>${full.display?.latest?'Message mis en forme · images distantes bloquées':'Version texte'}</span>${when(full.displayStatus==='failed',()=>html`<button class="link-btn" data-on-click="retryMailDisplay" data-id="${sel.id}">Recharger la mise en forme</button>`)}${when(full.display?.latest,()=>html`<button class="link-btn" data-on-click="toggleMailText" data-id="${sel.id}">${s.mailText?.[sel.id]?'Afficher la mise en forme':'Afficher le texte'}</button>`)}</div><div class="${cls('msg-body',full.display?.latest && !s.mailText?.[sel.id] && 'mail-rich')}">${full.failed ? sel.preview : full.display?.latest && !s.mailText?.[sel.id]?raw(full.display.latest):full.body}</div>` : html`
        <div style="display:flex;flex-direction:column;gap:8px;max-width:720px;padding:18px 0 22px">
          <div class="skeleton" style="width:100%"></div><div class="skeleton" style="width:91.6%"></div><div class="skeleton" style="width:60%"></div>
        </div>`}
      ${olderButton(s, full, sel.id)}
      ${when(trail.length, () => html`
        <div class="mail-trail">
          ${[...trail].reverse().map((t, i) => {
            const key = `${sel.id}:${i}`;
            return html`
              <article class="trail-card"><button class="${cls('trail-item', s.expandedTrail[key] && 'is-open')}" data-on-click="toggleTrail" data-trail="${key}" aria-expanded="${!!s.expandedTrail[key]}">
                <span class="avatar">${t.initials}</span><span class="trail-heading"><span><b>${t.from}</b><time>${timeLabel(t)}</time></span><span class="trail-preview">${t.body.replace(/\n/g,' ').slice(0,160)}</span></span><span>${s.expandedTrail[key]?'−':'+'}</span></button>
                ${when(s.expandedTrail[key],()=>html`<div class="msg-body ${full.display?.items[t.id] && !s.mailText?.[sel.id]?'mail-rich':''}">${full.display?.items[t.id] && !s.mailText?.[sel.id]?raw(full.display.items[t.id]):t.body}</div>`)}</article>`;
          })}
        </div>`)}
      ${when(s.composing, () => html`
        <div class="composer">
          <div class="composer-head">
            <span class="grow">${composeLabel}</span>
            <button class="composer-close" data-on-click="closeComposer" aria-label="Fermer">×</button>
          </div>
          ${when(s.composing === 'forward', () => html`
            <label class="composer-to">
              <span>À</span>
              <input data-key="to-${sel.id}" data-on-input="composeTo" ${raw(s.confirm?.messageId === sel.id ? 'readonly' : '')} value="${s.composeTo[sel.id] ?? (full?.draft?.mode === 'forward' ? full.draft.to : '') ?? ''}" placeholder="adresse@exemple.fr" autocomplete="off" maxlength="2000">
            </label>`)}
          ${draftConflict(s, sel.id)}
          <textarea data-autofocus data-key="draft-${sel.id}" data-on-input="draft" ${raw(s.confirm?.messageId === sel.id ? 'readonly' : '')} placeholder="Répondre à ${sel.from.split(' ')[0]} depuis ${sel.account}…">${draft}</textarea>
          <div class="composer-foot">
            <button class="btn btn-ghost" data-on-click="aiDraft">✳ Aider à rédiger</button>
            ${(() => {
              const st = draftState(s, v, sel.id, draft);
              return html`<span class="${cls('composer-status ellipsis', st && `is-${st.tone}`)}" role="status">${st ? st.label : sel.draft ? `${sel.draft.synced ? 'Brouillon synchronisé' : 'Brouillon'} enregistré à ${timeOf(sel.draft.savedAt)}` : 'Brouillon'}</span>`;
            })()}
            <button class="btn btn-ghost" data-on-click="saveDraft">Enregistrer</button>
            ${(() => {
              const acc = v.profile.accounts.find(a => a.id === sel.accountId);
              const allowed = !!acc?.perms?.includes('send');
              const title = allowed ? 'Vérifier puis envoyer' : 'L’envoi demande un compte de messagerie avec la permission Envoi';
              return html`<button class="btn btn-brand" data-on-click="sendPreview" title="${title}" ${raw(allowed && draft.trim() && !s.confirm && !(s.draftMeta || {})[sel.id]?.conflict && !s.offline ? '' : 'disabled')}>Vérifier avant l’envoi</button>`;
            })()}
          </div>
        </div>`)}
    </div>`;
}

// ---------- Discussion WhatsApp ----------

const WA_MAX = 4096; // limite d'envoi côté serveur
const dayKey = ms => new Date(ms).toDateString();
function dayLabel(ms) {
  const d = new Date(ms), today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return 'Aujourd’hui';
  if (d >= today - DAY) return 'Hier';
  const label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return label[0].toUpperCase() + label.slice(1);
}
const fullDate = ms => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
// Direction : uniquement le booléen fromMe fourni par le serveur, jamais déduite d'un nom.
const isMine = m => m.fromMe === true;

// Chronologie ancien → récent : le fil est stocké du plus récent au plus ancien, le dernier message est `full`.
function waMessages(sel, full) {
  const older = [...(full.trail || [])].reverse().map(t => ({ mine: isMine(t), at: t.at, body: t.body, author: full.group && !isMine(t) ? t.from : null }));
  return [...older, { mine: isMine(full), at: full.at ?? sel.sortAt, body: full.failed ? sel.preview : full.body, author: full.group && !isMine(full) ? full.from : null }];
}

function waTimeline(msgs) {
  let prev = null;
  return msgs.map(m => {
    const at = Number.isFinite(m.at) ? m.at : null;
    const newDay = at !== null && (!prev || prev.at === null || dayKey(prev.at) !== dayKey(at));
    // Messages consécutifs du même auteur, à moins de 5 minutes : bulles groupées, sans pointe.
    const grouped = !newDay && prev && prev.mine === m.mine && at !== null && prev.at !== null && at - prev.at < 5 * 60000;
    prev = { ...m, at };
    return html`
      ${when(newDay, () => html`<div class="wa-day" role="separator"><span>${dayLabel(at)}</span></div>`)}
      <div class="${cls('wa-msg', m.mine ? 'wa-out' : 'wa-in', grouped && 'wa-cont')}">
        <div class="wa-bubble">
          ${when(m.author, () => html`<strong class="wa-author">${m.author}</strong>`)}
          <span class="sr-only">${m.mine ? 'Vous' : 'Reçu'} :</span>
          <span class="wa-text">${m.body}</span>
          ${when(at !== null, () => html`<time class="wa-time" datetime="${new Date(at).toISOString()}" title="${fullDate(at)}">${timeOf(at)}</time>`)}
        </div>
      </div>`;
  });
}

// Nom stable du correspondant, même quand le dernier message est sortant (« WhatsApp · Nom »).
const waName = (sel, full) => (full?.subject || sel.subject || '').replace(/^WhatsApp · /, '').trim() || sel.from.replace(/^Moi \(à (.*)\)$/, '$1');

function whatsappView(s, v, sel) {
  const full = s.details[sel.id];
  const name = waName(sel, full);
  const acc = v.profile.accounts.find(a => a.id === sel.accountId);
  const canSend = !!acc?.perms?.includes('send') && !full?.group;
  const draft = s.drafts[sel.id] ?? full?.draft?.text ?? '';
  const tooLong = draft.length > WA_MAX;
  const folderName = s.data.folders.find(f => f.id === sel.folderId)?.name;
  const st = draftState(s, v, sel.id, draft);
  const status = st ? st.label : sel.draft ? `Brouillon enregistré à ${timeOf(sel.draft.savedAt)}` : 'Brouillon';
  const conflict = !!(s.draftMeta || {})[sel.id]?.conflict;
  const hint = full?.group ? 'Groupe : lecture et IA · envoi non activé' : !canSend ? 'Envoi non autorisé pour ce compte' : s.confirm ? 'Vérification en cours' : 'Envoi seulement après l’aperçu exact';
  return html`
    <section class="wa" aria-label="Discussion WhatsApp avec ${name}">
      <header class="wa-head">
        <span class="avatar wa-avatar">${sel.initials}</span>
        <div class="wa-who">
          <strong class="ellipsis">${name}${full?.group ? ' · Groupe' : ''}</strong>
          <span class="ellipsis"><span class="wa-badge">${channelMark('whatsapp')}WhatsApp</span>${sel.account !== 'WhatsApp' ? sel.account : ''}${sel.handle ? ` · ${sel.handle}` : ''}${folderName ? ` · ${folderName}` : ''}</span>
        </div>
        <div class="wa-head-actions">
          <button class="link-btn" data-on-click="aiClassify">Classer</button>
          <button class="link-btn" data-on-click="aiSummary">${icon('sparkle')}Résumer</button>
        </div>
      </header>
      <div class="wa-timeline" data-key="wa-timeline-${sel.id}" data-chat-id="${sel.id}" data-ready="${String(!!full && !full.failed)}" role="log" aria-label="Messages, du plus ancien au plus récent">
        <div class="wa-thread">
          ${olderButton(s, full, sel.id)}
          ${full?.failed ? html`<div class="wa-note"><p>Discussion indisponible. Aperçu du dernier message :</p><p class="wa-text">${sel.preview}</p></div>` : full ? waTimeline(waMessages(sel, full)) : html`
            <div class="wa-msg wa-in"><div class="wa-bubble wa-loading"><div class="skeleton" style="width:220px"></div><div class="skeleton" style="width:140px"></div></div></div>`}
          ${when(full?.failed, () => html`<p class="wa-note">Discussion incomplète : seul l’aperçu est disponible.</p>`)}
        </div>
      </div>
      <footer class="wa-composer">
        ${draftConflict(s, sel.id)}
        <div class="wa-input">
          <textarea data-key="draft-${sel.id}" data-on-input="draft" ${raw(s.confirm?.messageId === sel.id ? 'readonly' : '')} rows="2" aria-label="Réponse à ${name}"
            placeholder="Écrire à ${name.split(' ')[0]} depuis ${sel.account}…">${draft}</textarea>
        </div>
        <div class="wa-actions">
          <button class="btn btn-ghost" data-on-click="aiDraft" title="Proposer une réponse avec l’assistant">✳ Aider à rédiger</button>
          <span class="${cls('wa-status ellipsis', (tooLong || st?.tone === 'error') && 'is-error', st?.tone === 'warn' && 'is-warn')}" role="status">${tooLong ? `${draft.length} / ${WA_MAX} caractères : trop long` : `${status} · ${hint}`}</span>
          <button class="btn btn-ghost" data-on-click="saveDraft">Enregistrer</button>
          <button class="btn wa-send" data-on-click="sendPreview" title="${canSend ? 'Vérifier le message exact avant l’envoi' : 'L’envoi demande la permission Envoi pour ce compte'}"
            ${raw(canSend && draft.trim() && !tooLong && !s.confirm && !conflict && !s.offline ? '' : 'disabled')}>Aperçu</button>
        </div>
      </footer>
    </section>`;
}

function replyMemoryPanel(s, sel) {
  const a=s.ai, memory=s.details[sel.id]?.replyMemory;
  if(!memory) return html`<p class="muted">Chargement de la mémoire locale…</p>`;
  if(!memory.available) return html`<p class="muted">La mémoire de style sera disponible dans une conversation d’un compte connecté.</p>`;
  const busy=a.loading || a.memoryBusy;
  return html`<section class="reply-memory" aria-label="Mémoire de cette conversation">
    <div class="reply-memory-head"><strong>Ton style, ici</strong><span class="reply-memory-badge">Dans Relay Desk</span></div>
    <p>${memory.enabled ? memory.sampleCount ? `${plural(memory.sampleCount,'exemple')} de tes messages envoyés` : 'La mémoire apprendra de tes prochains messages envoyés.' : 'Mémoire en pause pour cette conversation.'}</p>
    ${when(memory.enabled && memory.sampleCount>0,()=>html`
      <div class="reply-memory-traits">${memory.traits.map(t=>html`<span>${t}</span>`)}</div>
      ${when(memory.sampleCount<3,()=>html`<p class="muted">Encore peu d’exemples : le style reste à affiner.</p>`)}
      <details><summary>Voir quelques exemples</summary>${memory.examples.map(e=>html`<blockquote>${e.text}</blockquote>`)}</details>`)}
    <p class="muted">Exemples de style par conversation : jusqu’à 24, conservés 180 jours. Une suggestion peut aussi utiliser les échanges de cette personne dans le profil d’envoi, si son identité est unique. Mettre en pause désactive aussi cet historique pour les suggestions.</p>
    ${when(a.memoryConfirm,()=>html`<div class="reply-memory-reset"><p>Effacer cette mémoire ? Elle repartira de tes prochains envois. Les messages de la conversation seront conservés.</p>
      <button class="btn btn-ghost" data-on-click="aiMemoryCancel">Annuler</button><button class="btn btn-ghost" data-on-click="aiMemoryConfirm" ${raw(busy?'disabled':'')}>Effacer la mémoire</button></div>`)}
    ${when(!a.memoryConfirm,()=>html`<div class="reply-memory-actions"><button class="btn btn-ghost" data-on-click="aiMemoryToggle" ${raw(busy?'disabled':'')}>${memory.enabled?'Mettre en pause':'Réactiver'}</button><button class="btn btn-ghost" data-on-click="aiMemoryReset" ${raw(busy || !memory.sampleCount?'disabled':'')}>Réinitialiser</button></div>`)}
  </section>`;
}

function aiPanel(s, sel) {
  const ai = s.ai, draftMode = ai.mode === 'draft', classifyMode = ai.mode === 'classify';
  const categories = { action: 'À traiter', waiting: 'En attente', information: 'Information', newsletter: 'Newsletter', spam: 'Indésirable potentiel' };
  const priorities = { low: 'Basse', normal: 'Normale', high: 'Haute' };
  const folders = s.data.folders.filter(f => f.p === sel.p);
  const configured = s.data.ai?.configured;
  const localLabels = sel.channel === 'whatsapp';
  const result = ai.forId === sel.id ? ai.result : null;
  const n = sel.count || 1;
  return html`
    <div class="ai" role="dialog" aria-label="Assistant">
      <div class="ai-head">
        <span class="ai-logo">✳</span>
        <span style="display:flex;flex-direction:column;flex:1;min-width:0">
          <span class="network-eyebrow">UN REGARD EN PLUS</span><h2 class="ai-title">Assistant</h2>
          <span class="muted ellipsis" style="font-size:12px">${sel.subject} · ${plural(n, 'message')}</span>
        </span>
        <button class="close-btn" data-on-click="aiClose" aria-label="Fermer">×</button>
      </div>
      <div class="ai-tabs">
        ${[['summary', 'Résumer'], ['classify', 'Classer'], ['draft', 'Répondre']].map(([mode, label]) => html`
          <button class="${cls('ai-tab', ai.mode === mode && 'is-on')}" data-on-click="aiTab" data-mode="${mode}">${label}</button>`)}
      </div>
      <div class="ai-body">
        <p class="muted" style="font-size:12px;margin:0">${configured ? (draftMode ? 'À ta demande, le fil est transmis à Mistral. Avec la mémoire active, jusqu’à cinq exemples de ton style et des échanges pertinents de la personne dans le profil d’envoi peuvent le compléter. Aucun envoi automatique.' : 'À ta demande, le texte de ce fil est transmis à Mistral. Aucun déplacement ni envoi automatique.') : 'L’IA attend sa configuration. Ajoute MISTRAL_API_KEY au fichier .env sur ton Mac, puis redémarre Relay Desk.'}</p>
        ${when(draftMode, () => html`
          ${replyMemoryPanel(s,sel)}
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
        ${when(result, () => classifyMode ? html`
          <div class="ai-result"><strong>${categories[result.category]}</strong><br>Priorité : ${priorities[result.priority]}<br>${result.reason}</div>
          <label class="field"><span class="field-label">Dossier à appliquer</span>
            <select data-on-change="aiFolder" ${raw(ai.loading || result.appliedAt ? 'disabled' : '')}>
              <option value="" ${raw(!ai.folderId ? 'selected' : '')}>Garder le dossier actuel</option>
              ${folders.map(f => html`<option value="${f.id}" ${raw(ai.folderId === f.id ? 'selected' : '')}>${f.name}</option>`)}
            </select>
          </label>
          <p class="muted" style="font-size:12px;margin:0">${result.appliedAt ? 'Classement déjà appliqué.' : localLabels ? 'Catégorie, priorité et dossier restent dans Relay Desk, dans Relay Desk.' : 'La catégorie et la priorité restent dans Relay Desk. Le dossier choisi sera synchronisé avec ton compte.'}</p>` : html`<div class="ai-result"><span class="network-eyebrow">${draftMode?'PROPOSITION DE RÉPONSE':'L’ESSENTIEL DU FIL'}</span><div class="ai-result-text">${result.text}</div></div>`)}
        ${when(draftMode && result?.personHistory,()=>html`<section class="reply-memory person-reply-context" aria-label="Historique utilisé pour la suggestion"><strong>Historique de ${result.personHistory.person.name}</strong><p>${plural(result.personHistory.sources.length,'conversation')} associées${result.personHistory.styleSamples?` · ${plural(result.personHistory.styleSamples,'exemple')} de ton style en complément`:''}.</p><details><summary>Voir les échanges utilisés</summary>${result.personHistory.sources.map(x=>html`<p><strong>${x.subject}</strong><br><span class="muted">${whenLabel(x.at)} · ${x.account}</span></p>`)}</details></section>`)}
        ${when(draftMode && result?.memoryUsed,()=>html`<span class="muted">Proposition adaptée à ${result.memorySamples} exemples de cette conversation.</span>`)}
        ${when(result?.createdAt, () => html`<span class="muted" style="font-size:11px">Analyse enregistrée à ${timeOf(result.createdAt)}${result.cached ? ' · réutilisée' : ''}</span>`)}
      </div>
      <div class="ai-foot">
        ${when(result, () => html`<button class="btn btn-ghost" data-on-click="aiRegenerate" ${raw(ai.loading || ai.memoryBusy || !configured ? 'disabled' : '')}>Régénérer</button>`)}
        <div class="grow"></div>
        ${when(draftMode && result, () => html`<button class="btn btn-brand" data-on-click="aiInsert" ${raw(ai.loading ? 'disabled' : '')}>Insérer dans la réponse</button>`)}
        ${when(classifyMode && result && !result.appliedAt, () => html`<button class="btn btn-brand" data-on-click="aiApply" ${raw(ai.loading ? 'disabled' : '')}>Appliquer le classement</button>`)}
        ${when(!result, () => html`
          <button class="btn btn-brand" data-on-click="aiRun" ${raw(ai.loading || ai.memoryBusy || !configured ? 'disabled' : '')}>
            ${when(ai.loading, () => html`<span class="spinner"></span>`)}${ai.mode === 'summary' ? 'Résumer' : classifyMode ? 'Analyser le classement' : 'Proposer une réponse'}
          </button>`)}
      </div>
    </div>`;
}

// ---------- Contacts ----------

function contactsPage(s, v) {
  const all = v.contacts.length > 0 && v.picked.length === v.contacts.length;
  const sortLabel = SORTS.find(x => x[0] === s.sort)[1];
  return html`
    <main class="contacts">
      <div class="contacts-scroll">
        <div class="contacts-head">
          ${when(s.mobile, () => html`<button class="icon-btn mobile-only" data-on-click="openDrawer" aria-label="Ouvrir le menu" aria-expanded="${!!s.drawer}">${icon('lines')}</button>`)}
          <div style="display:flex;flex-direction:column;gap:4px">
            <h1>${v.groupTitle}</h1>
            <span class="muted" style="font-size:13px">${plural(v.contacts.length, 'contact')}</span>
          </div>
          <button class="btn btn-ghost" data-on-click="selectApp" data-app="duplicates">Vérifier les doublons</button><button class="btn btn-brand" data-on-click="openContactImport">Importer des contacts</button>
        </div>

        <div class="contact-mode-bar"><div class="contact-mode" aria-label="Affichage des contacts"><button class="${cls(s.contactView==='network' && 'is-on')}" data-on-click="contactView" data-view="network" aria-pressed="${s.contactView==='network'}">◎ Réseau</button><button class="${cls(s.contactView==='list' && 'is-on')}" data-on-click="contactView" data-view="list" aria-pressed="${s.contactView==='list'}">☷ Liste</button></div><button class="btn btn-ghost" data-on-click="openGroup">+ Créer un groupe</button>${when((s.data.personGroups || []).some(g=>g.id===s.group),()=>html`<button class="link-btn" data-on-click="openGroup" data-id="${s.group}">Gérer le groupe</button>`)}</div>
        <div class="contacts-tools">
          <div class="group-tabs">
            ${(v.groups || GROUPS).map(([id, label]) => html`
              <button class="${cls('group-tab', s.group === id && 'is-on')}" data-on-click="selectGroup" data-id="${id}">${icon('list')}${label}</button>`)}
          </div>
          <div class="contacts-actions">
            ${when(true, () => html`
              <div style="width:180px"><input class="input" data-autofocus placeholder="Rechercher un contact" value="${s.contactQuery}" data-on-input="contactQuery"></div>`)}

            <button class="icon-btn" data-on-click="cycleSort" title="${sortLabel}">${icon('sort')}</button>
            <button class="icon-btn" data-on-click="toggleContactSearch" title="Rechercher">${icon('search')}</button>
          </div>
        </div>

        ${when(v.picked.length, () => html`
          <div class="picked-bar">
            <span style="font-weight:600;white-space:nowrap">${v.picked.length} sélectionné${v.picked.length > 1 ? 's' : ''}</span>
            <div class="grow"></div>
            ${when(v.picked.length===1,()=>html`<button class="btn btn-ghost" data-on-click="focusContact" data-id="${v.picked[0].id}">Voir la personne et ses échanges</button>`)}
            <button class="btn btn-ghost" data-on-click="clearPicked">Désélectionner</button>
          </div>`)}

        ${s.contactView==='network'?networkView(s,v):html`<div class="table">
          <div class="trow">
            <div class="cell-check">${checkbox(all, 'toggleAll', '', 'Tout sélectionner')}</div>
            <span class="th">Nom</span><span class="th">Titre</span><span class="th">Fréquence</span><span class="th">Canaux</span><span class="th" style="text-align:right">Dernier échange</span>
          </div>
          ${v.contacts.map(c => {
            const [avBg, avFg] = AV[c.name.length % AV.length];
            return html`
              <div class="${cls('trow body', s.picked[c.id] && 'is-picked', s.focusId === c.id && 'is-focus')}" data-key="${c.id}" data-on-click="focusContact" data-id="${c.id}">
                <div class="cell-check">${checkbox(!!s.picked[c.id], 'pickContact', c.id, `Sélectionner ${c.name}`)}</div>
                <div class="cell-name"><span class="avatar" style="background:${avBg};color:${avFg}">${initialsOf(c.name)}</span><button class="person-name ellipsis" data-on-click="focusContact" data-id="${c.id}">${c.name}</button></div>
                <span class="cell-title ellipsis" style="color:${c.title ? 'var(--foreground)' : 'var(--muted-foreground)'}">${s.profileId==='all'?c.profiles?.map(p=>p.name).join(' · ')+(c.title?' · '+c.title:''):c.title || 'Ajouter un titre…'}</span>
                <div style="padding:0 12px"><button class="${cls('freq', c.freq && 'is-set')}" data-on-click="cycleFreq" data-id="${c.id}">${FREQ[c.freq]}</button></div>
                <div class="cell-channels">
                  ${CONTACT_CHANNELS.map(k => {
                    const has = c.ch.includes(k);
                    return html`<span class="ch-mark" role="img" aria-label="${CH[k].label} : ${has ? 'présent' : 'absent'}" title="${CH[k].label} : ${has ? 'présent' : 'absent'}" style="background:${has ? CH[k].tint : 'var(--muted)'};color:${has ? CH[k].ink : 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)'}">${has ? channelMark(k) : '—'}</span>`;
                  })}
                </div>
                <span class="cell-last">${c.last}</span>
              </div>`;
          })}
          ${when(!v.contacts.length, () => html`<div class="empty">Aucun contact</div>`)}
        </div>`}
      </div>
    </main>`;
}

const checkbox = (on, action, id, label) => html`
  <button class="checkbox" role="checkbox" aria-checked="${on}" aria-label="${label}" data-on-click="${action}" data-id="${id}">${when(on, () => icon('check'))}</button>`;

// ---------- Assistant de connexion ----------

function whatsappConnectDialog(s) {
 const c=s.c,profile=s.data.profiles.find(p=>p.id===c.profile),done=c.step==='done';
 return html`<div class="overlay" data-on-click="closeConnect"><section class="dialog wa-connect-dialog" role="dialog" aria-modal="true" aria-label="Connexion WhatsApp" data-on-click="noop">
  <header class="wa-connect-heading"><div class="wa-connect-brand"><span class="network-eyebrow">VOTRE MESSAGERIE, DANS RELAY DESK</span><img class="wa-brand-wordmark" src="/icons/whatsapp-wordmark-black.svg" width="156" height="36" alt="WhatsApp"></div><button class="close-btn" data-on-click="closeConnect" aria-label="Fermer">×</button></header>
  <div class="dialog-body">
   <p class="muted" style="margin:0">${done?'Connecté au profil':'Connexion au profil'} <strong>${profile?.name || ''}</strong></p>
   ${done ? html`<div class="wa-connect-success" role="status"><strong>WhatsApp est connecté</strong><p>${c.real?.threads || 0} conversations reçues. La synchronisation continue en arrière-plan.</p></div>` : html`
    <div class="wa-qr-layout">
      <div class="whatsapp-link" role="status">${c.link?.qrDataUrl && !c.error ? html`<img class="whatsapp-qr" src="${c.link.qrDataUrl}" width="264" height="264" alt="QR code pour connecter WhatsApp à Relay Desk">` : html`${when(!c.error,()=>html`<span class="spinner"></span>`)}<span>${c.error?'Liaison indisponible':c.link?.status==='syncing'?'Téléphone connecté, synchronisation en cours…':'Préparation du QR code…'}</span>`}</div>
      <div><h3>Scanne pour connecter ton compte</h3><ol class="wa-link-steps"><li>Ouvre WhatsApp sur ton téléphone.</li><li>Va dans <strong>Réglages → Appareils connectés</strong> (sur Android : menu ⋮).</li><li>Choisis <strong>Connecter un appareil</strong> et scanne ce QR code.</li></ol><p class="muted">Le compte est identifié automatiquement après le scan.</p></div>
    </div>
    <p class="muted wa-connect-note">Les textes individuels et de groupe disponibles sur les 7 derniers jours seront synchronisés. L’historique reçu peut rester partiel.</p>
    <p class="wa-connect-note"><strong>Tu gardes le contrôle.</strong> Chaque envoi exige ton approbation de l’aperçu exact. Les groupes restent en lecture et analyse.</p>
    <p class="muted wa-connect-note">Connecteur communautaire non officiel. Relie uniquement un compte que tu possèdes ou es autorisé à connecter.</p>`}
   ${when(c.error,()=>html`<div class="alert" role="alert">${c.error}</div>`)}
  </div><footer class="dialog-foot">${done?html`<button class="btn btn-primary" data-on-click="cNext">Ouvrir la boîte</button>`:html`${when(c.error,()=>html`<button class="btn btn-primary" data-on-click="refreshWhatsAppQR">Réessayer</button>`)}<button class="btn btn-ghost" data-on-click="closeConnect">Fermer</button>`}</footer>
 </section></div>`;
}

function connectWizard(s) {
  if(s.c.svc==='whatsapp') return whatsappConnectDialog(s);
  const c = s.c, d = c.svc ? s.data.services[c.svc] : null;
  const PERM = s.data.permissions;
  const si = c.step === 'done' ? 3 : STEPS.findIndex(x => x[0] === c.step);
  const permsOn = d ? d.perms.filter(k => c.perms[k]) : [];
  const missing = d?.auth === 'fields' && d.fields.some(f => !f[5] && !String(c.fields[f[0]] || '').trim());
  const msgs = Math.round(c.win * 6.4);
  const profileName = id => s.data.profiles.find(p => p.id === id).name;
  const next = c.svc === 'whatsapp' && c.step === 'auth' && c.linkId ? null : { config: 'Continuer', auth: d?.btn, done: 'Ouvrir la boîte' }[c.step];
  const nextDisabled = c.busy || (c.step === 'auth' ? missing : c.step === 'config' ? !c.name.trim() : false);
  const importMeta = c.real ? `${c.real.done} / ${c.real.total} conversations` : `${Math.round(msgs * c.progress / 100)} / ${msgs}`;
  const checks = [['Autorisation reçue', 1, ''], ['Capacités vérifiées', c.real ? 2 : 20, `${permsOn.length} accès`], [`Import des ${c.svc==='whatsapp'?'7 derniers jours':historyLabel(c.historyDays ?? c.win)}`, 100, importMeta], ['Triage local', 100, '']];
  const stats = c.real ? [[c.real.messages, 'messages importés'], [c.real.threads, 'conversations'], [c.real.todo, 'à traiter']]
    : [[msgs, 'messages importés'], [Math.round(msgs / 3.2), 'conversations'], [Math.round(msgs / 22), 'à traiter']];
  const barColor = p => p === 100 ? 'var(--success)' : p >= 75 ? 'var(--primary)' : p >= 50 ? 'var(--warning)' : p >= 25 ? 'var(--status-high)' : 'var(--destructive)';

  return html`
    <div class="overlay" data-on-click="closeConnect">
      <div class="dialog connection-dialog" role="dialog" aria-modal="true" aria-label="Ajouter un canal" data-on-click="noop">
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
                  <span class="service-mark" style="background:${CH[sv.ch].tint};color:${CH[sv.ch].ink}">${providerMark(k, sv.ch)}</span>
                  <span style="display:flex;flex-direction:column;gap:2px;flex:1">
                    <span style="font-size:14px;font-weight:600">${sv.name}</span>
                    <span class="muted" style="font-size:12px">${sv.note}</span>
                  </span>
                  ${when(sv.state || !sv.real, () => html`<span class="badge badge-outline">${sv.state || 'Démonstration'}</span>`)}
                  <span class="muted">›</span>
                </button>`)}
            </div>`)}

          ${when(d && c.step !== 'pick', () => html`
            <div class="svc-head">
              ${when(d.ch !== 'whatsapp', () => html`<span class="service-mark" style="background:${CH[d.ch].tint};color:${CH[d.ch].ink}">${providerMark(c.svc, d.ch)}</span>`)}
              <div style="display:flex;flex-direction:column;gap:2px">
                <h3>${d.ch === 'whatsapp' ? html`<img class="wa-brand-wordmark" src="/icons/whatsapp-wordmark-black.svg" width="156" height="36" alt="WhatsApp">` : d.name}</h3>
                <span class="muted" style="font-size:13px">${c.step === 'done' ? `Connecté au profil ${profileName(c.profile)}` : d.note}</span>
              </div>
            </div>`)}

          ${when(c.step === 'config', () => html`
            ${when(c.svc === 'outlook', () => html`<p class="muted">Microsoft regroupe le classement et les brouillons dans la même permission Mail.ReadWrite.</p>`)}
            <div class="field" style="gap:8px">
              <span class="field-label">Profil de destination</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                ${s.data.profiles.filter(p=>p.id!=='all').map(p => html`<button class="${cls('pill', p.id === c.profile && 'is-on')}" data-on-click="cProfile" data-id="${p.id}" ${raw(c.accountId ? 'disabled' : '')}>${p.name}</button>`)}
              </div>
            </div>
            <label class="field" style="gap:8px">
              <span class="field-label">Nom du compte</span>
              <input class="input" value="${c.name}" data-on-input="cName" maxlength="80" ${raw(c.accountId ? 'readonly' : '')}>
            </label>
            <div class="field" style="gap:8px">
              <span class="field-label">Permissions</span>
              <div class="perms">
                ${d.perms.map(k => {
                  const soon = d.available && !d.available.includes(k);
                  return html`
                  <div class="perm">
                    <span style="display:flex;flex-direction:column;gap:2px;flex:1">
                      <span style="font-size:13px;font-weight:600">${PERM[k][0]}</span>
                      <span class="muted" style="font-size:12px">${soon ? 'Disponible dans une prochaine version' : d.real && d.scopes?.[k] ? d.scopes[k][0] : PERM[k][1]}</span>
                    </span>
                    <button class="switch" role="switch" aria-checked="${!soon && !!c.perms[k]}" aria-label="${PERM[k][0]}" data-on-click="cPerm" data-perm="${k}" ${raw(k === 'read' || soon || d.auth === 'qr' ? 'disabled' : '')}></button>
                  </div>`;
                })}
              </div>
            </div>
            ${when(c.accountId && d.auth === 'oauth', () => html`<p class="muted" style="font-size:12px">Une permission supplémentaire demande une nouvelle autorisation du fournisseur. Décocher un accès déjà accordé ne le révoque pas chez le fournisseur.</p>`)}
            ${d.auth==='oauth'?html`<label class="field"><span class="field-label">Historique conservé dans Relay Desk</span><select data-on-change="cHistory" aria-label="Historique du nouveau compte" ${raw(c.accountId?'disabled':'')}>${historyOptions(c.historyDays ?? 365)}</select><small class="muted">${c.accountId?'Modifiable dans Paramètres → Historique et stockage.':'Un an par défaut. Fenêtre glissante, réglable ensuite par compte. Les originaux restent chez le fournisseur.'}</small></label>`:html`<div class="field"><span class="field-label">Historique à importer</span><span>7 jours disponibles</span></div>`}`)}

          ${when(c.step === 'auth', () => html`
            <div class="recap">
              <span class="muted">Profil</span><span style="font-weight:600">${profileName(c.profile)}</span>
              <span class="muted">Compte</span><span style="font-weight:600">${c.name}</span>
              <span class="muted">Accès</span><span style="font-weight:600">${permsOn.map(k => PERM[k][0]).join(', ')}</span>
              <span class="muted">Historique</span><span style="font-weight:600">${c.svc==='whatsapp'?'7 derniers jours':historyLabel(c.historyDays ?? c.win)}</span>
            </div>
            ${when(d.auth === 'qr', () => html`
              ${when(!c.linkId, () => html`<p class="muted" style="margin:0">${d.scopesNote}</p>`)}
              ${when(!c.linkId, () => html`<p class="muted" style="margin:0">Discussions individuelles et groupes en texte, sur les 7 derniers jours disponibles. Groupes en lecture et analyse ; envoi réservé aux discussions individuelles. Médias, messages éphémères et vue unique exclus. L’historique disponible dépend de WhatsApp.</p>`)}
              ${when(!c.linkId && c.accountId, () => html`<p class="muted" style="margin:0">La liaison de cet appareil Relay Desk sera renouvelée avec historique étendu. Tes messages, dossiers et drapeaux restent conservés. WhatsApp peut transmettre des lots plus anciens ; seuls les 7 derniers jours sont enregistrés dans Relay Desk.</p>`)}
              <p class="muted" style="font-size:12px;margin:0">Connecteur communautaire non officiel : la liaison peut être interrompue ou limitée par WhatsApp.</p>
              <div class="whatsapp-link">
                ${when(c.busy || (c.linkId && !c.link?.qrDataUrl && !c.error && c.link?.status !== 'connected'), () => html`<span class="spinner"></span><span>${c.link?.status === 'syncing' ? 'Liaison reçue, synchronisation en cours…' : 'Préparation de la liaison…'}</span>`)}
                ${when(c.link?.qrDataUrl && !c.error, () => html`<img class="whatsapp-qr" src="${c.link.qrDataUrl}" alt="QR code pour lier WhatsApp à Relay Desk"><ol class="wa-link-steps"><li>Ouvre WhatsApp sur le téléphone de ce compte.</li><li>Va dans <strong>Réglages → Appareils connectés</strong> (sur Android : menu ⋮).</li><li>Choisis <strong>Connecter un appareil</strong> et scanne ce QR code.</li></ol><span class="muted" style="font-size:12px">Ce QR code donne à cet appareil Relay Desk accès à la lecture et à l’envoi. Relay Desk demande ta validation avant chaque envoi.</span>`)}
                ${when(c.linkId && c.error, () => html`<button class="btn btn-ghost" data-on-click="refreshWhatsAppQR">Obtenir un nouveau QR code</button>`)}
              </div>`)}
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
              ${stats.map(([n, label]) => html`
                <div class="stat"><strong>${n}</strong><span class="muted" style="font-size:12px">${label}</span></div>`)}
            </div>`)}
        </div>

        <div class="dialog-foot">
          ${when(!c.busy && !c.linkId && ((c.step === 'config' && !c.fromAccount) || c.step === 'auth'), () => html`<button class="btn btn-ghost" data-on-click="cBack">Retour</button>`)}
          <div class="grow"></div>
          ${when(next, () => {
            const branded = c.step === 'auth' && d?.auth === 'oauth' && ['gmail', 'outlook'].includes(c.svc);
            return branded ? html`<button class="provider-auth-button" data-on-click="cNext" aria-label="${c.svc === 'gmail' ? 'Sign in with Google' : 'Sign in with Microsoft'} — ${next}" title="${next}" ${raw(nextDisabled ? 'disabled' : '')}><img src="${c.svc === 'gmail' ? '/icons/google-sign-in.svg' : '/icons/microsoft-sign-in.svg'}" alt="${c.svc === 'gmail' ? 'Sign in with Google' : 'Sign in with Microsoft'}" height="40"></button>`
              : html`<button class="btn btn-brand" data-on-click="cNext" ${raw(nextDisabled ? 'disabled' : '')}>${next}</button>`;
          })}
        </div>
      </div>
    </div>`;
}

// ---------- Confirmation de déconnexion ----------

function disconnectDialog(c) {
  return html`
    <div class="overlay" data-on-click="confirmCancel">
      <div class="dialog dialog-sm account-disconnect" role="alertdialog" aria-modal="true" aria-label="Déconnecter ${c.name}" data-on-click="noop">
        <div class="dialog-body">
          <h3>Déconnecter ${c.name} ?</h3>
          <p class="muted" style="margin:0;font-size:14px;line-height:1.55">Les messages importés de ce compte seront retirés de Relay. Ils restent chez leur fournisseur. Le jeton conservé par Relay sera supprimé.</p>
          ${when(c.error, () => html`<div class="alert">${c.error}</div>`)}
        </div>
        <div class="dialog-foot">
          <div class="grow"></div>
          <button class="btn btn-ghost" data-on-click="confirmCancel" ${raw(c.busy ? 'disabled' : '')}>Annuler</button>
          <button class="btn btn-danger" data-on-click="confirmDisconnect" ${raw(c.busy ? 'disabled' : '')}>
            ${when(c.busy, () => html`<span class="spinner"></span>`)}Déconnecter
          </button>
        </div>
      </div>
    </div>`;
}

// ---------- Validation de l'envoi ----------

function sendDialog(c, offline = false) {
  const p = c.preview;
  return html`
    <div class="overlay" data-on-click="confirmCancel">
      <div class="dialog send-preview" role="alertdialog" aria-modal="true" aria-label="Vérifier le message avant l’envoi" data-on-click="noop">
        <header class="writing-head"><div><span class="network-eyebrow">DERNIÈRE RELECTURE</span><h3>Vérifier avant d’envoyer${p.channel === 'whatsapp' ? ' sur WhatsApp' : ''}</h3></div><span class="writing-step">Votre validation</span></header><div class="dialog-body">
          <div class="recap">
            <span class="muted">De</span><span>${p.from}</span>
            <span class="muted">À</span><span>${p.to.join(', ')}</span>
            ${when(p.cc.length, () => html`<span class="muted">Cc</span><span>${p.cc.join(', ')}</span>`)}
            ${when(p.channel !== 'whatsapp', () => html`<span class="muted">Objet</span><span style="font-weight:600">${p.subject}</span>`)}
          </div>
          <div class="send-preview-letter"><span class="network-eyebrow">MESSAGE EXACT</span><div class="send-body">${p.body}</div></div>
          <p class="muted" style="margin:0;font-size:12px">Ce texte est exactement celui qui sera envoyé. Toute modification demande une nouvelle vérification.</p>
          ${when(c.error, () => html`<div class="alert">${c.error}</div>`)}
          ${when(offline && !c.error, () => html`<div class="alert">Hors ligne : l’envoi reprendra seulement quand tu le confirmeras en ligne.</div>`)}
        </div>
        <div class="dialog-foot">
          <div class="grow"></div>
          <button class="btn btn-ghost" data-on-click="confirmCancel" ${raw(c.busy ? 'disabled' : '')}>Annuler</button>
          <button class="btn btn-brand" data-on-click="confirmSend" ${raw(c.busy || c.stale || offline ? 'disabled' : '')}>
            ${when(c.busy, () => html`<span class="spinner"></span>`)}Confirmer l’envoi
          </button>
        </div>
      </div>
    </div>`;
}

const MAIL_KEYS = ['to', 'cc', 'subject', 'text'];
function newMailStatus(c) {
  if (c.busy) return 'En cours…';
  if (c.conflict) return 'Conflit : non enregistré';
  if (c.saving) return 'Enregistrement…';
  if (c.saveError) return 'Non enregistré';
  if (MAIL_KEYS.some(k => (c[k] ?? '') !== ((c.saved || {})[k] ?? ''))) return 'Modifications non enregistrées';
  return c.savedAt ? `${c.synced ? 'Brouillon synchronisé' : 'Brouillon enregistré'} à ${timeOf(c.savedAt)}` : 'Non enregistré';
}
function newMailDialog(s, v) {
  const c = s.newMail;
  const accounts = v.profile.accounts.filter(a => a.channel === 'email' && a.perms?.includes('read'));
  const account = accounts.find(a => a.id === c.accountId);
  const disabled = raw(c.busy ? 'disabled' : '');
  return html`<div class="overlay"><section class="dialog new-mail-dialog" role="dialog" aria-modal="true" aria-label="Nouveau message">
    <div class="composer-head writing-head"><div class="grow"><span class="network-eyebrow">PRENDRE LE TEMPS D’ÉCRIRE</span><h3>Nouveau message</h3></div><button class="composer-close" data-on-click="closeNewMail" aria-label="Fermer le nouveau message" ${disabled}>×</button></div>
    ${accounts.length ? html`<div class="compose-fields">
      <label>De<select data-on-change="newMailField" data-field="accountId" ${raw(c.busy || c.saving || c.messageId ? 'disabled' : '')}>
        ${accounts.map(a => html`<option value="${a.id}" ${raw(a.id === c.accountId ? 'selected' : '')}>${a.profileName?`${a.profileName} · `:''}${a.name} — ${a.address || ''}</option>`)}
      </select></label>
      ${providerBadge(account)}
      <label>À<input data-key="new-to" data-on-input="newMailField" data-field="to" value="${c.to}" maxlength="2000" placeholder="adresse@exemple.fr" ${disabled}></label>
      <label>Cc<input data-key="new-cc" data-on-input="newMailField" data-field="cc" value="${c.cc}" maxlength="2000" ${disabled}></label>
      <label>Objet<input data-key="new-subject" data-on-input="newMailField" data-field="subject" value="${c.subject}" maxlength="998" ${disabled}></label>
      <label class="compose-message">Message<textarea data-key="new-body" data-on-input="newMailField" data-field="text" maxlength="20000" placeholder="Rédige ton message…" ${disabled}>${c.text}</textarea></label>
      ${when(c.conflict, () => html`<div class="draft-conflict" role="alert">
        <p>Ce brouillon a été modifié ailleurs. Ton texte est conservé ici et n’a pas été enregistré.</p>
        <div><button class="btn btn-ghost" data-on-click="newMailReload" ${raw(c.saving || c.busy ? 'disabled' : '')}>Recharger</button>
        <button class="btn btn-ghost" data-on-click="newMailKeepMine" ${raw(c.saving || c.busy ? 'disabled' : '')}>Garder ma version</button></div>
      </div>`)}
      ${when(c.error || c.saveError, () => html`<p role="alert" class="error">${c.error || `Non enregistré : ${c.saveError}`}</p>`)}
      </div><div class="composer-foot"><button class="btn btn-ghost" data-on-click="aiNewMail" ${raw(c.busy || !s.data.ai?.configured ? 'disabled' : '')}>✳ Améliorer avec l’IA</button>
        <span class="composer-status" role="status">${newMailStatus(c)}</span>
        <button class="btn btn-ghost" data-on-click="saveNewMail" ${raw(c.busy || c.conflict || s.offline ? 'disabled' : '')}>Enregistrer</button>
        <button class="btn btn-brand" data-on-click="previewNewMail" ${raw(!c.busy && !c.saving && !c.conflict && !s.offline && account?.perms?.includes('send') && c.text.trim() && c.to.trim() ? '' : 'disabled')}>Vérifier avant l’envoi</button>
      </div>
      ${when(!account?.perms?.includes('send'), () => html`<p class="muted">Active la permission Envoi pour envoyer depuis ce compte.</p>`)}
      ${when(!s.data.ai?.configured, () => html`<p class="muted">L’assistant sera disponible après configuration de l’IA.</p>`)}
    ` : html`<p>Connecte un compte Gmail ou Outlook pour rédiger un message.</p><button class="btn btn-brand" data-on-click="newMailConnect">Connecter un compte</button>`}
  </section></div>`;
}


function authDevices(s) {
  const devices=Array.isArray(s.authPanel)?s.authPanel:s.authPanel.sessions || [];
  return html`<div class="overlay" data-on-click="authClose"><section class="dialog auth-dialog" role="dialog" aria-modal="true" aria-labelledby="devices-title" data-on-click="noop">
    <h2 id="devices-title">Appareils connectés</h2>
    <p class="muted">Fermer une session retire son accès aux messages et à l’assistant.</p>
    ${devices.map(device=>html`<div class="auth-device"><div><strong>${device.current || device.id===s.auth?.sessionId?'Cet appareil':device.device || 'Autre session'}</strong><p class="muted">Connexion : ${new Date(device.createdAt || device.authenticatedAt).toLocaleString('fr-FR')}</p></div><button class="btn btn-ghost" data-on-click="authRevoke" data-id="${device.id}">Déconnecter</button></div>`)}
    <div class="auth-dialog-actions"><a class="btn btn-ghost" href="/auth/login?reauth=1">Confirmer mon identité</a><button class="btn btn-brand" data-on-click="authClose">Fermer</button></div>
  </section></div>`;
}


function contactImportDialog(s,v) {
 const accounts=v.profile.accounts.filter(a=>['gmail','outlook'].includes(a.svc));
 return html`<div class="overlay"><section class="dialog person-dialog" role="dialog" aria-modal="true" aria-label="Importer des contacts">
 <header class="composer-head"><h3 class="grow">Importer des contacts · ${v.profile.name}</h3><button class="close-btn" data-on-click="closeContactImport" aria-label="Fermer">×</button></header>
 <div class="dialog-body"><p>Importer les noms, emails et téléphones en lecture seule. Les carnets d’origine restent inchangés. Chaque compte reste dans son profil.</p>
 ${accounts.map(a=>html`<article class="contact-import-account">${providerMark(a.svc,a.channel)}<div class="grow"><strong>${a.name}</strong><p class="muted">${a.address || ''}</p></div>
 ${a.perms?.includes('contacts') ? html`<button class="btn btn-brand" data-on-click="importContacts" data-id="${a.id}" ${raw(s.contactImportBusy || s.offline?'disabled':'')}>${s.contactImportBusy===a.id?'Import en cours…':'Importer le carnet'}</button>`:html`<button class="btn btn-ghost" data-on-click="authorizeContacts" data-id="${a.id}" ${raw(s.offline?'disabled':'')}>Autoriser les contacts</button>`}</article>`)}
 ${when(!accounts.length,()=>html`<p>Connecte un compte Google ou Outlook dans ce profil.</p>`)}
 <p class="muted">Les doublons restent séparés jusqu’à ta validation. Aucun message n’est envoyé pendant l’import.</p></div></section></div>`;
}
function personDialog(s,v) {
 const p=s.person,source=v.contactsMine.find(c=>c.id===s.personMerge);
 const disabled=raw(s.personBusy || s.offline?'disabled':'');
 const identityList=items=>items.map(i=>html`<li><span class="identity-kind">${i.kind==='email'?'Email':'Téléphone'}</span><span class="grow">${i.value}${when(i.needsCountryCode,()=>html` <small>· pays à préciser avant rapprochement</small>`)}${when(i.sharedWith>1,()=>html` <small>· partagé par ${i.sharedWith} fiches, rapprochement à confirmer</small>`)}</span><small class="muted">${({gmail:'Google',outlook:'Outlook',whatsapp:'WhatsApp',manual:'Ajout manuel'})[i.source] || i.source}</small>
 ${when(i.source==='manual',()=>html`<button class="link-btn" data-on-click="removePersonIdentity" data-kind="${i.kind}" data-normalized="${i.normalized}" ${disabled}>Retirer</button>`)}</li>`);
 return html`<div class="overlay"><section class="dialog person-dialog person-profile" role="dialog" aria-modal="true" aria-label="Fiche contact">
 <header class="person-profile-head"><span class="person-profile-avatar" aria-hidden="true">${p?initialsOf(p.name):'…'}</span><div class="grow"><small class="network-eyebrow">VOTRE CARNET · ${v.profile.name}</small><h3>${p?.name || 'Fiche contact'}</h3>${when(p,()=>html`<p>${[p.title,...(p.profiles || []).map(x=>x.name)].filter(Boolean).join(' · ')}</p>`)}</div><button class="close-btn" data-on-click="closePerson" aria-label="Fermer la fiche contact">×</button></header>
 <div class="dialog-body person-body">${when(s.personError,()=>html`<p role="alert" class="error">${s.personError}</p>`)}
 ${p?html`<div class="person-profile-layout"><aside class="person-facts"><section class="person-fact-section"><h4>Emails et téléphones</h4><ul class="identity-list">${identityList(p.identities)}</ul>
 <details class="person-add-identity" ${raw(s.personAddOpen?'open':'')}><summary data-on-click="togglePersonAdd">+ Ajouter un email ou téléphone</summary><div class="identity-form"><label>Type<select data-on-change="personField" data-field="personKind"><option value="email" ${raw(s.personKind==='email'?'selected':'')}>Email</option><option value="phone" ${raw(s.personKind==='phone'?'selected':'')}>Téléphone</option></select></label><label class="grow">Identifiant<input class="input" data-key="person-identity" value="${s.personValue}" placeholder="${s.personKind==='phone'?'+33…':'adresse@exemple.fr'}" data-on-input="personField" data-field="personValue" maxlength="254"></label><button class="btn btn-ghost" data-on-click="addPersonIdentity" ${disabled}>Ajouter</button></div></details></section>
 <details class="person-merge" ${raw(s.personMergeOpen?'open':'')}><summary data-on-click="togglePersonMerge">Lier ou séparer des fiches</summary><p>Lie uniquement les fiches de la même personne. Une adresse partagée ou un numéro familial peut appartenir à plusieurs personnes. La liaison reste dans ${v.profile.name} et peut être annulée.</p>
 ${when(p.candidates.length,()=>html`<p class="muted">Identifiant commun avec : ${p.candidates.map(c=>c.name).join(', ')}. À vérifier avant de lier.</p>`)}
 <label>Autre fiche dans ce profil<select data-on-change="personField" data-field="personMerge"><option value="">Choisir une fiche…</option>${v.contactsMine.filter(c=>c.id!==p.id).map(c=>html`<option value="${c.id}" ${raw(s.personMerge===c.id?'selected':'')}>${c.name} · ${(c.identities || []).map(i=>i.value).slice(0,2).join(' · ')}</option>`)}</select></label>
 ${when(source,()=>html`<div class="merge-review"><strong>${source.name}</strong><ul class="identity-list">${identityList((source.identities || []).map(i=>({...i,source:i.source==='manual'?'Ajout manuel (autre fiche)':i.source})))}</ul><p>Cette fiche et celle de ${p.name} seront regroupées. Les conversations et destinataires d’origine seront conservés.</p><button class="btn btn-brand" data-on-click="mergePerson" ${disabled}>Confirmer la liaison de ces fiches</button></div>`)}
 ${p.merges.map(m=>html`<p><button class="link-btn" data-on-click="undoPersonMerge" data-id="${m.id}" ${disabled}>Annuler la liaison du ${new Date(m.created_at).toLocaleString('fr-FR')}</button></p>`)}</details>
 <section class="person-groups person-fact-section"><h4>Vos groupes</h4><p class="muted">Organisez vos relations.</p><div>${(s.data.personGroups || []).map(g=>html`<button class="group-membership ${g.members.includes(p.id)?'is-on':''}" aria-pressed="${g.members.includes(p.id)}" data-on-click="toggleGroupMember" data-group="${g.id}" data-id="${p.id}" data-on="${!g.members.includes(p.id)}" ${raw(s.groupBusy?'disabled':'')}>${g.members.includes(p.id)?'✓':'+'} ${g.name}</button>`)}<button class="group-membership" data-on-click="openGroup">+ Nouveau groupe</button></div></section>
 </aside><section class="person-history"><div class="person-history-heading"><div><span class="network-eyebrow">AU FIL DES ÉCHANGES</span><h4>Votre histoire</h4></div><span class="person-total">${plural(p.timeline.total,'conversation')}</span></div>
 ${when(p.timeline.activity,()=>html`<p class="person-activity"><strong>${plural(p.timeline.activity.messages,'message')}</strong>${p.timeline.activity.firstAt?` · depuis ${whenLabel(p.timeline.activity.firstAt)}`:''}</p><p class="muted">${p.timeline.activity.channels.map(c=>`${CH[c.channel]?.label || c.channel} : ${c.conversations}`).join(' · ')}</p>`)}
 ${when(p.identities.some(i=>i.sharedWith>1),()=>html`<p class="muted">Les identifiants partagés ne regroupent pas les échanges automatiquement. Lie les fiches après vérification si elles représentent la même personne.</p>`)}<div class="person-timeline">${p.timeline.items.map(m=>html`<button class="person-exchange" data-on-click="personConversation" data-id="${m.id}"><span class="person-exchange-meta">${providerMark(v.profile.accounts.find(a=>a.id===m.accountId)?.svc || m.channel,m.channel)}<span>${m.profileName?m.profileName+' · ':''}${m.account}</span><time>${whenLabel(m.sortAt)}</time></span><strong>${m.subject || CH[m.channel]?.label || 'Conversation'}</strong>${when(m.preview,()=>html`<span class="person-exchange-preview">${m.preview}</span>`)}<span class="person-exchange-count">${plural(m.count,'message')} <span aria-hidden="true">↗</span></span></button>`)}</div>
 ${when(!p.timeline.items.length,()=>html`<p>Aucun échange correspondant dans l’historique importé. Ajoute un email ou téléphone connu, ou lie une autre fiche de cette personne.</p>`)}
 ${when(p.timeline.nextOffset!==null,()=>html`<button class="btn btn-ghost" data-on-click="personMore" ${disabled}>Afficher les conversations plus anciennes</button>`)}
 <p class="person-history-footnote">Ouvrez un échange pour répondre. Chaque envoi exige votre validation de l’aperçu exact.</p></section></div>`:html`<p>Chargement de la fiche…</p>`}</div></section></div>`;
}

// Duplicate workbench: evidence remains visible; every merge has its own review step.
function duplicatesPage(s,v) {
 const d=s.duplicates,items=d?.items || [],pending=items.filter(c=>!c.dismissed),dismissed=items.filter(c=>c.dismissed),visible=(s.duplicatesTab==='dismissed'?dismissed:pending),busy=raw(s.duplicatesBusy || s.offline?'disabled':'');
 const record=(c,expanded)=>html`<article class="duplicate-person"><div class="duplicate-person-head"><span class="avatar">${initialsOf(c.name)}</span><div><h3>${c.name}</h3><small>${c.profiles?.map(p=>p.name).join(' · ')} ${c.accounts.join(' · ') || 'Fiche locale'} · ${plural(c.members.length,'fiche')}</small></div></div>${when(c.title,()=>html`<p class="muted">${c.title}</p>`)}<ul>${c.identities.slice(0,expanded?undefined:6).map(i=>html`<li><span>${i.kind==='email'?'Email':'Tél.'}</span>${i.value}${when(i.normalized.startsWith('unresolved:'),()=>html` <small>· pays à préciser</small>`)}</li>`)}</ul>${when(!expanded && c.identities.length>6,()=>html`<small>+ ${c.identities.length-6} autres identifiants visibles avant confirmation</small>`)}</article>`;
 return html`<main class="contacts duplicate-page"><div class="contacts-scroll"><div class="duplicate-workbench"><header class="duplicates-head">${when(s.mobile,()=>html`<button class="icon-btn mobile-only" data-on-click="openDrawer" aria-label="Ouvrir le menu">${icon('lines')}</button>`)}<div class="grow"><p class="duplicates-eyebrow">CONTACTS · ${v.profile.name}</p><h1>Doublons à vérifier</h1><p>Un carnet plus clair, une personne à la fois.</p></div><button class="btn btn-ghost" data-on-click="rescanDuplicates" ${busy}>${s.duplicatesBusy?'Recherche…':'Relancer la recherche'}</button></header>
 <p class="muted duplicate-note">La recherche s’actualise en arrière-plan dans ce profil. Compare les fiches avant de les fusionner. Les carnets Google et Outlook restent inchangés.</p>
 <div class="duplicates-toolbar"><button class="pill ${s.duplicatesTab==='pending'?'is-on':''}" data-on-click="duplicateTab" data-tab="pending">À examiner · ${pending.length}</button><button class="pill ${s.duplicatesTab==='dismissed'?'is-on':''}" data-on-click="duplicateTab" data-tab="dismissed">Écartés · ${dismissed.length}</button><span class="muted">${d?.scannedAt?'Dernière analyse : '+new Date(d.scannedAt).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'Première analyse en cours…'}</span></div>
 ${when(s.duplicatesError,()=>html`<p class="duplicate-error" role="alert">${s.duplicatesError}</p>`)}${when(d?.pending,()=>html`<p class="muted" role="status">Des fiches ont changé. La prochaine analyse actualisera les suggestions.</p>`)}${when(d?.crowded || d?.limited,()=>html`<p class="muted">Certaines correspondances trop nombreuses sont limitées. La liaison manuelle reste disponible dans chaque fiche.</p>`)}
 <div class="duplicates-list">${visible.slice(0,s.duplicatesLimit).map(c=>{const review=s.duplicatesReview?.id===c.id,r=review?s.duplicatesReview:c;return html`<section class="duplicate-card" data-key="${c.id}"><div class="duplicate-evidence"><strong>${c.rank===2?'Identifiant commun':'Nom à rapprocher'}</strong>${c.reasons.map(r=>html`<span>${r.type==='name'?'Même nom, accents et ordre ignorés':r.type==='email'?'Email identique : '+r.value:'Téléphone identique : '+r.value}</span>`)}</div><div class="duplicate-pair">${record(r.left,review)}${record(r.right,review)}</div><footer class="duplicate-actions"><p>${c.stale?'Ces fiches ont changé : relance la recherche.':c.rank===2?'Une adresse partagée peut appartenir à plusieurs personnes.':'Un nom identique peut désigner deux personnes différentes.'}</p>${c.dismissed?html`<button class="btn btn-ghost" data-on-click="dismissDuplicate" data-id="${c.id}" data-restore="true" ${busy}>Remettre à examiner</button>`:html`<button class="btn btn-ghost" data-on-click="dismissDuplicate" data-id="${c.id}" ${busy}>Écarter</button><button class="btn btn-brand" data-on-click="reviewDuplicate" data-id="${c.id}" ${raw(c.stale || s.duplicatesBusy || s.offline?'disabled':'')}>Comparer et fusionner</button>`}</footer>
 ${when(review,()=>html`<div class="duplicate-confirm"><h4>Vérifier la fusion</h4><p>Tous les emails, téléphones et échanges seront réunis sous la fiche principale. Les destinataires des conversations restent inchangés. Tu pourras annuler cette fusion.</p><label>Fiche principale<select data-on-change="duplicateKeep"><option value="${r.left.id}" ${raw(s.duplicatesKeep===r.left.id?'selected':'')}>${r.left.name} · ${r.left.accounts.join(', ')}</option><option value="${r.right.id}" ${raw(s.duplicatesKeep===r.right.id?'selected':'')}>${r.right.name} · ${r.right.accounts.join(', ')}</option></select></label><div><button class="btn btn-ghost" data-on-click="cancelDuplicateReview" ${busy}>Annuler</button><button class="btn btn-brand" data-on-click="confirmDuplicateMerge" ${busy}>Confirmer la fusion</button></div></div>`)}</section>`;})}</div>
 ${when(!d,()=>html`<p role="status">Chargement des suggestions…</p>`)}${when(d && !visible.length,()=>html`<div class="duplicates-empty"><h2>${s.duplicatesTab==='dismissed'?'Aucune suggestion écartée':'Aucun doublon à examiner'}</h2><p>${d.pending?'L’analyse est en cours.':'De nouvelles correspondances apparaîtront ici si tes fiches changent.'}</p></div>`)}${when(visible.length>s.duplicatesLimit,()=>html`<button class="btn btn-ghost" data-on-click="duplicatesMore">Afficher d’autres suggestions</button>`)}
 ${when(d?.merges.length,()=>html`<details class="duplicate-history"><summary>Fusions récentes · ${d.merges.length}</summary>${d.merges.map(m=>html`<div><p>${m.sourceName} → ${m.targetName}<small>${new Date(m.created_at).toLocaleString('fr-FR')}</small></p><button class="btn btn-ghost" data-on-click="undoDuplicateMerge" data-id="${m.id}" ${busy}>Annuler cette fusion</button></div>`)}</details>`)}<p class="muted duplicate-note">Les suggestions sont calculées sur le serveur, sans envoyer ton carnet à une IA. Aucun message n’est envoyé depuis cet écran.</p></div></div></main>`;
}

function contactHistoryPage(s,v) {
 return html`<main class="contacts"><div class="contacts-scroll"><div class="duplicate-workbench"><header class="duplicates-head">${when(s.mobile,()=>html`<button class="icon-btn mobile-only" data-on-click="openDrawer" aria-label="Ouvrir le menu">${icon('lines')}</button>`)}<div><p class="duplicates-eyebrow">CONTACTS · ${v.profile.name}</p><h1>Liens et fusions</h1><p>Les rapprochements que tu as validés restent enregistrés.</p></div></header><p class="muted duplicate-note">Les fiches sources, emails et téléphones restent attachés à leur compte. L’historique conserve les fusions et leurs annulations, y compris après redémarrage ou réimportation du carnet.</p>${when(s.contactHistoryError,()=>html`<p role="alert" class="duplicate-error">${s.contactHistoryError}</p>`)}${s.contactHistory?html`<div class="saved-links">${s.contactHistory.map(e=>html`<article class="duplicate-card saved-link"><div><small>${e.scope_name} · ${new Date(e.created_at).toLocaleString('fr-FR')}</small><h3>${e.source_name} → ${e.target_name}</h3><small>${e.sourceProfiles.join(' · ')} → ${e.targetProfiles.join(' · ')}</small><p>${e.undone_at?'Fusion annulée le '+new Date(e.undone_at).toLocaleString('fr-FR'):e.kind==='unified'?'Lien dans la vue unifiée · comptes d’origine conservés':'Fusion enregistrée dans le profil d’origine'}</p></div>${when(e.canUndo,()=>html`<button class="btn btn-ghost" data-on-click="undoSavedMerge" data-id="${e.id}" ${raw(s.historyBusy || s.offline?'disabled':'')}>Annuler cette fusion</button>`)}${when(!e.available,()=>html`<small>Historique conservé · source retirée ou modifiée</small>`)}</article>`)}</div>${when(!s.contactHistory.length,()=>html`<div class="duplicates-empty"><h2>Aucune fusion enregistrée dans cette vue</h2><p>Les prochaines fusions validées apparaîtront ici.</p></div>`)}`:html`<p role="status">Chargement de l’historique…</p>`}</div></div></main>`;
}

function groupDialog(s,v){return html`<div class="overlay"><section class="dialog group-dialog" role="dialog" aria-modal="true" aria-label="Groupe de contacts"><header class="composer-head"><h3 class="grow">${s.groupEditor==='new'?'Créer un groupe':'Gérer le groupe'}</h3><button class="close-btn" data-on-click="closeGroup" aria-label="Fermer le groupe">×</button></header><div class="dialog-body"><p class="muted">${v.profile.name} · Vous choisissez les personnes de ce groupe. Les carnets Google et Outlook restent inchangés.</p><label>Nom du groupe<input class="input" data-autofocus value="${s.groupName}" data-on-input="groupName" maxlength="80" placeholder="Famille, équipe, investisseurs…"></label><p class="muted">Ajoutez ou retirez les membres depuis leur fiche contact. Les appartenances sont conservées lors des liaisons et peuvent être retirées.</p><button class="btn btn-brand" data-on-click="saveGroup" ${raw(s.groupBusy || !s.groupName.trim()?'disabled':'')}>Enregistrer le groupe</button>${when(s.groupEditor!=='new',()=>html`<h4>Membres du groupe</h4><input class="input" type="search" aria-label="Rechercher des membres" placeholder="Rechercher une personne…" value="${s.groupQuery}" data-on-input="groupQuery"><div class="group-member-list">${v.contactsMine.filter(c=>!s.groupQuery.trim() || (c.name+' '+c.identities.map(i=>i.value).join(' ')).toLocaleLowerCase().includes(s.groupQuery.trim().toLocaleLowerCase())).map(c=>{const on=(s.data.personGroups || []).find(g=>g.id===s.groupEditor)?.members.includes(c.id);return html`<button class="group-member-row" role="checkbox" aria-checked="${!!on}" data-on-click="toggleGroupMember" data-group="${s.groupEditor}" data-id="${c.id}" data-on="${!on}" ${raw(s.groupBusy?'disabled':'')}><span>${on?'✓':'＋'}</span><strong>${c.name}</strong></button>`;})}</div><button class="btn btn-ghost" data-on-click="closeGroup">Terminer</button>`)}</div></section></div>`;}

const HISTORY_OPTIONS=[[30,'30 jours'],[90,'3 mois'],[180,'6 mois'],[365,'1 an'],[730,'2 ans'],[0,'Tout l’historique']];
const historyLabel=days=>HISTORY_OPTIONS.find(([d])=>d===days)?.[1] || `${days} jours`;
const historyOptions=days=>HISTORY_OPTIONS.map(([d,label])=>html`<option value="${d}" ${raw(d===days?'selected':'')}>${label}</option>`);
const storageLabel=bytes=>bytes<1048576?`${Math.round(bytes/1024)} Ko`:`${(bytes/1048576).toFixed(1)} Mo`;
function mailSettingsPage(s,v){const accounts=s.data.profiles.filter(p=>p.id!=='all').flatMap(p=>p.accounts.map(a=>({...a,profileName:p.name}))).filter(a=>['gmail','outlook'].includes(a.svc));return html`<main class="contacts settings-page"><div class="contacts-scroll"><header class="settings-heading">${when(s.mobile,()=>html`<button class="icon-btn" data-on-click="openDrawer" aria-label="Ouvrir le menu">${icon('lines')}</button>`)}<div><p class="network-eyebrow">PARAMÈTRES · VOS COMPTES</p><h1>Historique et stockage</h1><p>Gardez le contexte utile, à votre rythme.</p></div></header><p class="settings-intro">Choisissez la période conservée pour chaque compte. La fenêtre avance automatiquement : les messages plus anciens quittent le cache de Relay Desk. Les originaux restent dans Gmail ou Outlook, et les brouillons en cours gardent leur contexte.</p>${when(s.mailSettingsError,()=>html`<p role="alert" class="error">${s.mailSettingsError}</p>`)}<div class="settings-accounts">${accounts.map(a=>{const p=s.mailSettings[a.id],days=s.mailSettingsDays[a.id],busy=s.mailSettingsBusy===a.id;return html`<section class="history-account-card"><header>${providerMark(a.svc,a.channel)}<div><h2>${a.name}</h2><p>${a.address} · ${a.profileName}</p></div></header>${p?html`<div class="history-account-stats"><span><strong>${p.conversations.toLocaleString('fr-FR')}</strong> conversations</span><span><strong>${storageLabel(p.contentBytes)}</strong> de contenu de messages</span><span>Actuellement : <strong>${historyLabel(p.days)}</strong></span></div><div class="history-account-control"><label>Historique à conserver<select data-on-change="historyWindowChange" data-id="${a.id}" aria-label="Historique de ${a.name}" ${raw(busy?'disabled':'')}>${historyOptions(days)}</select></label><button class="btn btn-brand" data-on-click="reviewHistoryWindow" data-id="${a.id}" ${raw(busy || days===p.days || s.offline?'disabled':'')}>${busy?'Préparation…':'Examiner la modification'}</button></div><p class="muted">Réduire la période libère le cache local à l’application du réglage. L’élargir relance l’import en arrière-plan, sans doublons. Les réponses conservent leur validation avant envoi.</p>`:html`<p>Chargement du réglage…</p>`}</section>`;})}${when(!accounts.length,()=>html`<p>Aucun compte Gmail ou Outlook ajouté.</p><button class="btn btn-brand" data-on-click="openConnect">Ajouter un compte</button>`)}</div><p class="settings-footnote">Nouveaux comptes : 1 an par défaut. WhatsApp garde sa fenêtre disponible de 7 jours et reste indépendant de ce réglage. Les contacts, liens entre personnes et groupes sont conservés.</p></div></main>`;}
function historyWindowReview(s){const r=s.mailSettingsPreview,busy=s.mailSettingsBusy===r.accountId;return html`<div class="overlay"><section class="dialog history-review" role="dialog" aria-modal="true" aria-label="Confirmer la période de conservation"><header class="composer-head"><h3 class="grow">${r.name} · ${historyLabel(r.requestedDays)}</h3><button class="close-btn" data-on-click="cancelHistoryWindow" aria-label="Fermer la modification" ${raw(busy?'disabled':'')}>×</button></header><div class="dialog-body"><p><strong>${r.address}</strong></p><p>${r.removeConversations} conversations et ${r.removeOlderMessages} anciens messages de conversations récentes seront retirés du cache de Relay Desk.</p><p>${r.protectedDrafts} conversation(s) ancienne(s) conservée(s) pour protéger un brouillon et son contexte.</p><p>Les originaux chez Google ou Microsoft restent inchangés. Vous pourrez réimporter une période plus large ensuite. Le réglage s’applique automatiquement aux prochaines synchronisations.</p><p>La mémoire de style et les analyses liées aux anciens contenus sont nettoyées. Aucun message ne sera envoyé.</p>${when(s.mailSettingsError,()=>html`<p role="alert">${s.mailSettingsError}</p>`)}<button class="btn btn-brand" data-on-click="applyHistoryWindow" ${raw(busy?'disabled':'')}>${busy?'Application et optimisation…':'Appliquer cette période'}</button></div></section></div>`;}
