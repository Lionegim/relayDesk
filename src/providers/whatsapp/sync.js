// Sessions WhatsApp (appareil lié) : liaison par QR, reprise des sessions enregistrées, import du texte récent
// des conversations directes. Rien n'est envoyé ici ; aucune connexion n'est ouverte sans session enregistrée
// ou demande de liaison explicite.
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError, badRequest, notFound } from '../../http/errors.js';
import { createAuthState, hasSession } from './auth.js';
import { chatToRecord, contactId, contactName, dayLabel, directJid, parseMessage, phoneOf } from './parse.js';

const LOGGED_OUT = 401;
const RESTART_REQUIRED = 515;
const MAX_CHATS = 500;          // discussions conservées par compte
const MAX_PER_CHAT = 200;       // messages conservés par discussion
const MAX_BATCH = 5000;         // messages traités par événement
const MAX_PENDING = 20;         // lots reçus avant la vérification d'identité
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createWhatsAppSync({ store, vault, lib, makeSocket, log = console, timing = {} }) {
  const T = {
    linkTtlMs: 5 * 60000,       // durée maximale d'une liaison avant validation sur le téléphone
    qrTtlMs: 60000,             // durée d'affichage d'un QR (Baileys le renouvelle avant)
    settleMs: 8000,             // délai avant de considérer l'import initial terminé
    retainMs: 10 * 60000,       // conservation d'une liaison terminée pour le suivi de la fenêtre
    retryBaseMs: 5000, retryMaxMs: 5 * 60000,
    ...timing,
  };
  const sessions = new Map();   // accountId -> session
  const links = new Map();      // linkId -> liaison
  const linkOf = new Map();     // accountId -> liaison en cours
  const retries = new Map();    // accountId -> { n, timer }
  const queues = new Map();
  const epochs = new Map();
  const forgetHooks = [];
  const epoch = id => epochs.get(id) || 0;
  let stopped = false, generationCounter = 0;
  const advance = accountId => {
    epochs.set(accountId, ++generationCounter);
    for (const fn of forgetHooks) fn(accountId);
  };
  const warn = msg => log.warn?.(`WhatsApp : ${msg}`); // jamais de QR, de clé ni de contenu

  function serial(accountId, fn) {
    const job = (queues.get(accountId) || Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    queues.set(accountId, tail);
    tail.then(() => { if (queues.get(accountId) === tail) queues.delete(accountId); });
    return job;
  }

  const isWhatsApp = id => id != null && store.hasAccount(id) && store.getAccount(id).svc === 'whatsapp';
  const current = (accountId, s) => sessions.get(accountId) === s && epoch(accountId) === s.at && !s.closed;
  const windowStart = accountId => Date.now() - (store.getSync(accountId)?.window_days || 7) * 86400000;

  function endSocket(s) {
    s.closed = true;
    s.auth.close();
    clearTimeout(s.settle);
    try { Promise.resolve(s.sock.end(undefined)).catch(() => {}); } catch { /* socket déjà fermé */ }
  }
  function dropSession(accountId, { resetRetry = true } = {}) {
    const s = sessions.get(accountId);
    if (s) { sessions.delete(accountId); endSocket(s); }
    clearTimeout(retries.get(accountId)?.timer);
    if (resetRetry) retries.delete(accountId);
  }

  // ---------- Liaisons ----------

  function finishLink(link) {
    clearTimeout(link.timer);
    link.qrDataUrl = null;
    if (linkOf.get(link.accountId) === link) linkOf.delete(link.accountId);
    setTimeout(() => links.delete(link.id), T.retainMs).unref?.();
  }
  function failLink(link, message) {
    if (link.done) return;
    link.done = true;
    link.status = 'error';
    link.error = message;
    finishLink(link);
    if (link.opened || epoch(link.accountId) !== link.at) return;
    advance(link.accountId);
    const s = sessions.get(link.accountId);
    if (s?.link === link) dropSession(link.accountId);
    if (!store.hasAccount(link.accountId)) return;
    store.waAuthClear(link.accountId);
    // Compte créé par cette liaison et jamais connecté : il disparaît. Un compte existant attend une reconnexion.
    if (link.created) store.deleteAccount(link.accountId);
    else {
      store.setAccountStatus(link.accountId, 'À reconnecter', 'warn');
      store.setSync(link.accountId, { status: 'error', error: message });
    }
  }

  async function showQr(link, qr) {
    if (link.done || link.paired || typeof qr !== 'string') return;
    let url;
    try {
      url = await QRCode.toDataURL(qr, { margin: 1, width: 264, errorCorrectionLevel: 'L' });
    } catch {
      return failLink(link, 'QR impossible à générer.');
    }
    if (link.done || link.paired) return;
    link.qrDataUrl = url;
    link.qrExpires = Date.now() + T.qrTtlMs;
    link.status = 'qr';
  }

  // ---------- Sessions ----------

  async function openSession(accountId, link = null) {
    const at = epoch(accountId);
    const auth = createAuthState({ store, vault, accountId, lib: await lib() });
    if (epoch(accountId) !== at || !store.hasAccount(accountId) || stopped || (link && link.done)) { auth.close(); return; }
    const sock = await makeSocket({ auth });
    const s = { sock, auth, at, link, open: false, verified: false, closed: false, pending: [], ephemeral: new Set(store.waEphemeralChats(accountId)), settle: null };
    if (epoch(accountId) !== at || !store.hasAccount(accountId) || stopped || (link && link.done)) { endSocket(s); return; }
    dropSession(accountId, { resetRetry: false });
    sessions.set(accountId, s);

    sock.ev.on('creds.update', () => {
      if (!current(accountId, s)) return;
      auth.saveCreds();
      // Le téléphone a validé le QR : la liaison ne peut plus être annulée par la fermeture de la fenêtre.
      if (link && !link.done && auth.state.creds.me?.id && !link.paired) {
        link.paired = true;
        link.qrDataUrl = null;
        link.status = 'syncing';
        clearTimeout(link.timer);
      }
    });
    sock.ev.on('connection.update', u => onConnection(accountId, s, u || {}));
    const batch = (kind, notify) => data => {
      if (!current(accountId, s)) return;
      if (!s.verified) { if (s.pending.length < MAX_PENDING) s.pending.push([kind, data, notify]); return; }
      handle(accountId, s, kind, data, notify);
    };
    sock.ev.on('messaging-history.set', batch('history', false));
    sock.ev.on('messages.upsert', d => batch('messages', d?.type === 'notify')(d));
    sock.ev.on('contacts.upsert', batch('contacts', false));
    sock.ev.on('contacts.update', batch('contacts', false));
    sock.ev.on('chats.update', batch('chats', false));
    sock.ev.on('chats.upsert', batch('chats', false));
  }

  function onConnection(accountId, s, { connection, lastDisconnect, qr }) {
    if (!current(accountId, s)) return;
    if (qr) {
      // Une session enregistrée qui redemande un QR n'est plus valable : aucun QR n'est montré sans demande.
      if (!s.link || s.link.done || s.link.paired) {
        dropSession(accountId);
        store.waAuthClear(accountId);
        if (s.link && !s.link.done) return failLink(s.link, 'Liaison interrompue : relance-la.');
        store.setAccountStatus(accountId, 'À reconnecter', 'warn');
        store.setSync(accountId, { status: 'error', error: 'Session WhatsApp expirée : relie à nouveau le téléphone.' });
        return;
      }
      showQr(s.link, qr);
    }
    if (connection === 'open') verify(accountId, s).catch(() => { if (current(accountId, s)) { dropSession(accountId); scheduleRetry(accountId, s.link); } });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      dropSession(accountId, { resetRetry: false });
      if (code === LOGGED_OUT) {
        store.waAuthClear(accountId);
        if (s.link && !s.link.done && !s.link.opened) return failLink(s.link, 'Liaison refusée par WhatsApp.');
        store.setAccountStatus(accountId, 'À reconnecter', 'warn');
        store.setSync(accountId, { status: 'error', error: 'Appareil retiré dans WhatsApp : relie à nouveau le téléphone.' });
        return;
      }
      // Après la validation du QR, WhatsApp demande un redémarrage du socket : même liaison, identifiants enregistrés.
      if (code === RESTART_REQUIRED) return reopen(accountId, s.link);
      if (s.link && !s.link.done && !s.link.opened && !s.link.paired) return failLink(s.link, 'QR expiré : relance la liaison.');
      scheduleRetry(accountId, s.link);
    }
  }

  function reopen(accountId, link) {
    openSession(accountId, link).catch(() => {
      if (link && !link.done && !link.opened) failLink(link, 'Impossible de poursuivre la liaison.');
      else scheduleRetry(accountId, link);
    });
  }

  function scheduleRetry(accountId, link = null) {
    if (stopped || !store.hasAccount(accountId) || !hasSession({ store, vault, accountId })) return;
    const r = retries.get(accountId) || { n: 0 };
    clearTimeout(r.timer);
    const delay = Math.min(T.retryBaseMs * 2 ** r.n, T.retryMaxMs);
    r.n++;
    const at = epoch(accountId);
    r.timer = setTimeout(() => { if (epoch(accountId) === at && !sessions.has(accountId)) reopen(accountId, link && !link.done ? link : null); }, delay);
    r.timer.unref?.();
    retries.set(accountId, r);
    store.setAccountStatus(accountId, 'Hors ligne', 'warn');
    store.setSync(accountId, { status: 'error', error: 'Connexion WhatsApp interrompue : nouvelle tentative automatique.' });
  }

  // Le compte est identifié par son numéro dès la connexion ; une autre identité n'est jamais substituée.
  async function verify(accountId, s) {
    if (!current(accountId, s) || s.verified || s.verifying) return;
    s.verifying = true;
    const me = directJid(s.sock.user?.id);
    const phone = phoneOf(me);
    const acc = store.getAccount(accountId);
    const clash = phone && store.accountsBySvc('whatsapp').some(id => {
      if (id === accountId) return false;
      const other = store.getAccount(id);
      return other.profileId === acc.profileId && other.address === phone;
    });
    const reason = !phone ? 'Identité WhatsApp illisible.'
      : acc.address && acc.address !== phone ? 'Ce téléphone ne correspond pas au compte WhatsApp enregistré.'
        : clash ? 'Ce numéro WhatsApp est déjà relié à un autre compte de ce profil.' : null;
    if (reason) {
      warn(`identité refusée pour le compte ${accountId}`);
      sessions.delete(accountId);
      s.closed = true;
      s.auth.close();
      // L'appareil qui vient d'être lié est retiré du téléphone, au mieux.
      try { await Promise.race([s.sock.logout(), new Promise((_, no) => setTimeout(no, 10000).unref?.())]); } catch { /* sans incidence */ }
      try { s.sock.end(undefined); } catch { /* déjà fermé */ }
      if (epoch(accountId) !== s.at || !isWhatsApp(accountId)) return;
      if (s.link && !s.link.done) return failLink(s.link, reason);
      store.waAuthClear(accountId);
      store.setAccountStatus(accountId, 'À reconnecter', 'warn');
      store.setSync(accountId, { status: 'error', error: reason });
      return;
    }
    s.open = true;
    s.verified = true;
    retries.delete(accountId);
    store.upsertAccount(acc.profileId, { name: acc.name, channel: 'whatsapp', svc: 'whatsapp', address: phone });
    store.setAccountStatus(accountId, 'Connecté', 'ok');
    store.setSync(accountId, { status: 'syncing', error: null });
    const link = s.link;
    if (link && !link.done) {
      link.opened = true;
      link.paired = true;
      link.status = 'syncing';
      if (linkOf.get(accountId) === link) linkOf.delete(accountId);
      clearTimeout(link.timer);
    }
    s.settle = setTimeout(() => settled(accountId, s), T.settleMs);
    s.settle.unref?.();
    for (const [kind, data, notify] of s.pending.splice(0)) handle(accountId, s, kind, data, notify);
  }

  function settled(accountId, s) {
    if (!current(accountId, s)) return;
    clearTimeout(s.settle);
    const counts = store.countThreads(accountId);
    store.setSync(accountId, { status: 'idle', total: counts.threads, done: counts.threads, last_sync_at: new Date().toISOString() });
    const link = s.link;
    if (link && !link.done) {
      link.done = true;
      link.status = 'connected';
      finishLink(link);
    }
  }

  // ---------- Import ----------

  function rebuild(accountId, chatJid, { incoming = false } = {}) {
    const msgs = store.waChatMessages(accountId, chatJid, MAX_PER_CHAT);
    if (!msgs.length) return;
    const name = store.waChatName(accountId, chatJid);
    const rec = chatToRecord(chatJid, msgs, { name, state: store.threadState(accountId, chatJid), incoming });
    store.upsertThread(accountId, rec, { syncFolder: true });
    const who = name || phoneOf(chatJid) || 'Contact WhatsApp';
    store.upsertAccountContact(accountId, chatJid, { id: contactId(accountId, chatJid), name: who, title: phoneOf(chatJid) || '', channel: 'whatsapp', last: dayLabel(msgs.at(-1).ts) });
  }

  function names(accountId, contacts) {
    const touched = new Set();
    for (const c of Array.isArray(contacts) ? contacts.slice(0, MAX_BATCH) : []) {
      const name = contactName(c);
      if (!name) continue;
      for (const jid of new Set([directJid(c?.id), directJid(c?.phoneNumber), directJid(c?.lid)])) {
        if (!jid) continue;
        store.waSetChatName(accountId, jid, name);
        touched.add(jid);
      }
    }
    return touched;
  }

  function policies(accountId, s, chats) {
    for (const ch of Array.isArray(chats) ? chats.slice(0, MAX_BATCH) : []) {
      const jid = directJid(ch?.id);
      if (!jid || !Object.hasOwn(ch, 'ephemeralExpiration')) continue;
      const value = Number(ch.ephemeralExpiration);
      if (!Number.isFinite(value) || value < 0) continue;
      const ephemeral = value > 0;
      if (ephemeral) s.ephemeral.add(jid); else s.ephemeral.delete(jid);
      store.waSetEphemeral(accountId, jid, ephemeral);
    }
  }

  function handle(accountId, s, kind, data, notify) {
    if (kind === 'chats') { policies(accountId, s, data); return; }
    if (kind === 'history') policies(accountId, s, data?.chats);
    if (kind === 'contacts') {
      const known = new Set(store.waChats(accountId));
      for (const jid of names(accountId, data)) if (known.has(jid)) rebuild(accountId, jid);
      return;
    }
    const unread = new Set();
    if (kind === 'history') {
      names(accountId, data?.contacts);
      for (const ch of Array.isArray(data?.chats) ? data.chats : []) {
        const jid = directJid(ch?.id);
        if (!jid) continue;
        if (typeof ch.name === 'string' && ch.name.trim()) store.waSetChatName(accountId, jid, ch.name.trim().slice(0, 80));
        if (Number(ch.unreadCount) > 0) unread.add(jid);
      }
    }
    const since = windowStart(accountId);
    const list = (Array.isArray(data?.messages) ? data.messages : []).slice(-MAX_BATCH)
      .map(m => parseMessage(m, { since })).filter(m => m && !s.ephemeral.has(m.chatJid));
    if (!list.length) return kind === 'history' && data?.isLatest ? settled(accountId, s) : undefined;
    // Nom public de l'expéditeur seulement si aucun nom n'est connu pour la discussion.
    for (const m of list) if (m.pushName && !store.waChatName(accountId, m.chatJid)) store.waSetChatName(accountId, m.chatJid, m.pushName);
    const known = new Set(store.waChats(accountId));
    let room = MAX_CHATS - known.size;
    const accepted = new Set(known);
    for (const m of list) if (!accepted.has(m.chatJid) && room > 0) { accepted.add(m.chatJid); room--; }
    const kept = list.filter(m => accepted.has(m.chatJid));
    const changed = store.waAddMessages(accountId, kept);
    const incoming = new Set(notify ? kept.filter(m => !m.fromMe && changed.has(m.chatJid)).map(m => m.chatJid) : []);
    for (const jid of changed) rebuild(accountId, jid, { incoming: incoming.has(jid) || (unread.has(jid) && !known.has(jid)) });
    if (kind === 'history' && data?.isLatest) settled(accountId, s);
  }

  // ---------- API ----------

  return {
    serial,
    generation: accountId => epoch(accountId),
    isWhatsApp,
    // Socket ouvert et identité vérifiée, ou null.
    liveSocket: accountId => { const s = sessions.get(accountId); return s && s.open && current(accountId, s) ? s.sock : null; },
    rebuild,
    onForget: fn => forgetHooks.push(fn),

    async startLink({ profileId, name, windowDays = 7, accountId = null } = {}) {
      if (typeof profileId !== 'string' || !store.hasProfile(profileId)) throw notFound('Profil introuvable');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw badRequest('Nom du compte invalide');
      if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) throw badRequest('Période d’import invalide');
      const label = name.trim();
      let created = false;
      if (accountId != null) {
        if (!Number.isInteger(accountId) || !store.hasAccount(accountId)) throw notFound('Compte introuvable');
        const acc = store.getAccount(accountId);
        if (acc.svc !== 'whatsapp' || acc.profileId !== profileId || acc.name !== label) throw badRequest('Ce compte ne correspond pas à la demande de reconnexion.');
      } else {
        const same = store.accountsBySvc('whatsapp').map(id => store.getAccount(id)).find(a => a.profileId === profileId && a.name === label);
        if (same && (same.address || hasSession({ store, vault, accountId: same.id }))) {
          throw new HttpError(409, 'Ce compte WhatsApp existe déjà : utilise la reconnexion.', 'whatsapp_exists');
        }
        if (same) accountId = same.id;
        else {
          accountId = store.upsertAccount(profileId, { name: label, channel: 'whatsapp', svc: 'whatsapp' }).id;
          created = true;
        }
      }
      if (linkOf.has(accountId)) throw new HttpError(409, 'Une liaison est déjà en cours pour ce compte.', 'link_in_progress');
      if (sessions.get(accountId)?.open) throw new HttpError(409, 'Ce compte WhatsApp est déjà connecté.', 'whatsapp_connected');
      advance(accountId);
      // Nouvel appareil lié : l'ancienne session (expirée ou retirée) est effacée avant le nouveau QR.
      dropSession(accountId);
      store.waAuthClear(accountId);
      store.setAccountStatus(accountId, 'En attente du QR', 'info');
      store.setSync(accountId, { status: 'linking', window_days: windowDays, error: null, total: 0, done: 0 });
      const link = { id: randomUUID(), accountId, at: epoch(accountId), created, status: 'starting', qrDataUrl: null, qrExpires: 0, error: null, paired: false, opened: false, done: false };
      links.set(link.id, link);
      linkOf.set(accountId, link);
      link.timer = setTimeout(() => { if (!link.opened && !link.paired) failLink(link, 'Délai de liaison dépassé : relance-la.'); }, T.linkTtlMs);
      link.timer.unref?.();
      openSession(accountId, link).catch(() => failLink(link, 'Impossible de démarrer la liaison WhatsApp.'));
      return { linkId: link.id, accountId };
    },

    linkStatus(linkId) {
      const link = typeof linkId === 'string' && UUID.test(linkId) ? links.get(linkId) : null;
      if (!link) throw notFound('Liaison introuvable ou expirée');
      const out = { status: link.status, accountId: link.accountId };
      if (link.status === 'qr' && link.qrDataUrl && link.qrExpires > Date.now()) out.qrDataUrl = link.qrDataUrl;
      if (link.error) out.error = link.error;
      if (['syncing', 'connected'].includes(link.status) && store.hasAccount(link.accountId)) {
        const c = store.countThreads(link.accountId);
        Object.assign(out, { threads: c.threads, messages: c.messages });
      }
      return out;
    },

    // N'annule qu'une liaison dont le QR n'a pas été validé. Après validation, fermer la fenêtre ne déconnecte rien :
    // seul disconnect(accountId) retire le compte.
    cancelLink(linkId) {
      const link = typeof linkId === 'string' && UUID.test(linkId) ? links.get(linkId) : null;
      if (!link) return { cancelled: false };
      if (link.done || link.paired || link.opened) return { cancelled: false, status: link.status };
      failLink(link, 'Liaison annulée.');
      return { cancelled: true };
    },

    permissions: accountId => (isWhatsApp(accountId) && hasSession({ store, vault, accountId }) ? ['read', 'drafts', 'send'] : []),
    progress(accountId) {
      const s = store.getSync(accountId);
      if (!s) return null;
      return { status: s.status, total: s.total, done: s.done, error: s.error, ...store.countThreads(accountId) };
    },
    // Pas de relevé à la demande chez WhatsApp : reconstruit les fils locaux et relance la session si elle est tombée.
    async syncNow(accountId) {
      if (!isWhatsApp(accountId)) throw badRequest('Ce compte n’est pas un compte WhatsApp.');
      for (const jid of store.waChats(accountId)) rebuild(accountId, jid);
      if (!sessions.has(accountId) && !linkOf.has(accountId) && hasSession({ store, vault, accountId })) reopen(accountId, null);
      return this.progress(accountId);
    },
    // Lu, drapeau, archive et dossier restent locaux : WhatsApp n'a pas d'équivalent fiable.
    updateMessage(id, patch) {
      const { accountId } = store.getMessageSource(id);
      if (!isWhatsApp(accountId)) throw badRequest('Ce message n’est pas une conversation WhatsApp.');
      return store.updateMessage(id, patch);
    },

    // Au démarrage du serveur : reprend seulement les sessions enregistrées et appairées.
    async start() {
      stopped = false;
      for (const accountId of store.accountsBySvc('whatsapp')) {
        if (sessions.has(accountId) || linkOf.has(accountId)) continue;
        if (!hasSession({ store, vault, accountId })) {
          store.setAccountStatus(accountId, 'À reconnecter', 'warn');
          continue;
        }
        store.setAccountStatus(accountId, 'Connexion…', 'info');
        reopen(accountId, null);
      }
    },
    stop() {
      stopped = true;
      for (const id of [...sessions.keys()]) dropSession(id);
      for (const r of retries.values()) clearTimeout(r.timer);
      retries.clear();
    },

    // Déconnexion explicite : retire l'appareil lié (au mieux), efface session, messages importés et compte.
    async disconnect(accountId) {
      if (!isWhatsApp(accountId)) throw badRequest('Ce compte n’est pas un compte WhatsApp.');
      advance(accountId);
      return serial(accountId, async () => {
        const link = linkOf.get(accountId);
        if (link) { link.done = true; link.status = 'error'; link.error = 'Compte déconnecté.'; finishLink(link); }
        const s = sessions.get(accountId);
        sessions.delete(accountId);
        clearTimeout(retries.get(accountId)?.timer);
        retries.delete(accountId);
        let revoked = false;
        if (s) {
          s.closed = true;
          s.auth.close();
          clearTimeout(s.settle);
          if (s.open) {
            try {
              await Promise.race([s.sock.logout(), new Promise((_, no) => setTimeout(() => no(new Error('délai')), 10000).unref?.())]);
              revoked = true;
            } catch {
              warn(`retrait de l’appareil non confirmé pour le compte ${accountId}`);
            }
          }
          try { s.sock.end(undefined); } catch { /* déjà fermé */ }
        }
        if (store.hasAccount(accountId)) {
          store.waAuthClear(accountId);
          store.waClearMessages(accountId);
          store.deleteAccount(accountId);
        }
        return { disconnected: true, revoked };
      });
    },
  };
}
