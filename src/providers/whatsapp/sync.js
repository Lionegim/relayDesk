// Sessions WhatsApp (appareil lié) : liaison par QR, reprise des sessions enregistrées, import du texte récent
// des conversations directes. Rien n'est envoyé ici ; aucune connexion n'est ouverte sans session enregistrée
// ou demande de liaison explicite.
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError, badRequest, notFound } from '../../http/errors.js';
import { createAuthState, hasSession } from './auth.js';
import { chatJid, chatToRecord, contactId, contactName, dayLabel, directJid, groupJid, parseMessage, phoneOf } from './parse.js';

// Discussion importable : directe ou groupe (chatJid). directJid reste réservé à l'identité du téléphone et aux
// personnes ; un groupe n'est jamais un contact.
const isGroup = jid => groupJid(jid) !== null;
// Titre d'un groupe : nom du groupe lui-même, jamais le nom public d'un participant.
const groupTitle = g => [g?.subject, g?.name, g?.displayName].find(v => typeof v === 'string' && v.trim())?.trim().slice(0, 120) || null;

const LOGGED_OUT = 401;
const RESTART_REQUIRED = 515;
const CHUNK = 1000;             // messages insérés par tranche (la boucle d'événements reste disponible entre deux)
const MAX_PENDING = 200;        // lots reçus avant la vérification d'identité
// Types du protocole (WAProto) : historique à la demande.
const PDO_HISTORY_ON_DEMAND = 3;
const PDO_FULL_HISTORY_ON_DEMAND = 6;
const HISTORY_RECENT = 3, HISTORY_FULL = 2, HISTORY_ON_DEMAND = 6;
const FULL_RESPONSE = {
  0: null,
  1: 'Demande expirée côté téléphone.',
  2: 'Le téléphone a refusé de partager l’historique.',
  3: 'Le téléphone n’a pas pu préparer l’historique.',
  4: 'Ce téléphone ne propose pas l’historique complet à la demande.',
  5: 'Appareil hébergé non connecté.',
  6: 'Appareil hébergé non configuré.',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createWhatsAppSync({ store, vault, lib, makeSocket, log = console, timing = {} }) {
  const T = {
    linkTtlMs: 5 * 60000,       // durée maximale d'une liaison avant validation sur le téléphone
    qrTtlMs: 60000,             // durée d'affichage d'un QR (Baileys le renouvelle avant)
    settleMs: 8000,             // délai avant de considérer l'import initial terminé
    retainMs: 10 * 60000,       // conservation d'une liaison terminée pour le suivi de la fenêtre
    retryBaseMs: 5000, retryMaxMs: 5 * 60000,
    historyIdleMs: 2 * 60000,   // sans nouveau lot pendant ce délai : historique déclaré partiel
    fullResponseMs: 20000,      // attente de la réponse du téléphone à la demande d'historique complet
    requestCooldownMs: 60000,   // une demande d'historique au plus par minute et par compte
    onDemandCount: 50,          // messages demandés par discussion et par tour
    onDemandRounds: 10,         // tours au plus par discussion
    onDemandSpacingMs: 250,     // intervalle entre deux demandes adressées au téléphone
    ...timing,
  };
  const sessions = new Map();   // accountId -> session
  const links = new Map();      // linkId -> liaison
  const linkOf = new Map();     // accountId -> liaison en cours
  const retries = new Map();    // accountId -> { n, timer }
  const queues = new Map();
  const epochs = new Map();
  const forgetHooks = [];
  const histories = new Map();  // accountId -> suivi de l'historique (aucun JID exposé)
  const requestOnOpen = new Set();
  const epoch = id => epochs.get(id) || 0;
  let stopped = false, generationCounter = 0;
  const advance = accountId => {
    epochs.set(accountId, ++generationCounter);
    for (const fn of forgetHooks) fn(accountId);
    resetHistory(accountId);
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
    clearTimeout(s.fullTimer);
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
    const sock = await makeSocket({ auth, linking: !!link });
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
      if (!s.verified) {
        if (s.pending.length < MAX_PENDING) s.pending.push([kind, data, notify]);
        else s.droppedPending = true;
        return;
      }
      enqueue(accountId, s, kind, data, notify);
    };
    sock.ev.on('messaging-history.set', batch('history', false));
    sock.ev.on('messages.upsert', d => batch('messages', d?.type === 'notify')(d));
    sock.ev.on('contacts.upsert', batch('contacts', false));
    sock.ev.on('contacts.update', batch('contacts', false));
    sock.ev.on('chats.update', batch('chats', false));
    sock.ev.on('chats.upsert', batch('chats', false));
    sock.ev.on('groups.upsert', batch('groups', false));
    sock.ev.on('groups.update', batch('groups', false));
    // Jalons d'historique signalés par Baileys : fin explicite (progression 100) ou pause (aucun lot depuis 2 min).
    // Le jalon suit les lots déjà reçus : jamais « terminé » avant la fin de leur import par tranches.
    sock.ev.on('messaging-history.status', st => {
      if (!current(accountId, s) || !s.verified) return;
      if (s.ingest) s.ingest.then(() => { if (current(accountId, s)) historyMilestone(accountId, st); });
      else historyMilestone(accountId, st);
    });
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
    // Une nouvelle liaison reçoit l'historique initial du téléphone ; une session reprise ne le reçoit pas d'office.
    if (link && !link.done) beginHistory(accountId, 'link');
    pruneAndRebuild(accountId);
    for (const [kind, data, notify] of s.pending.splice(0)) enqueue(accountId, s, kind, data, notify);
    if (s.droppedPending) lostHistory(accountId, 'Une partie des lots reçus avant la vérification a été ignorée.');
    if (requestOnOpen.delete(accountId)) requestHistory(accountId, s).catch(() => {});
  }

  // Connexion établie : la fenêtre de liaison peut se fermer. L'historique, lui, continue d'arriver et a son propre suivi.
  function settled(accountId, s) {
    if (!current(accountId, s)) return;
    clearTimeout(s.settle);
    const counts = store.countThreads(accountId);
    const active = ['waiting', 'receiving'].includes(histories.get(accountId)?.state);
    store.setSync(accountId, { status: active ? 'syncing' : 'idle', total: counts.threads, done: counts.threads, ...(active ? {} : { last_sync_at: new Date().toISOString() }) });
    const link = s.link;
    if (link && !link.done) {
      link.done = true;
      link.status = 'connected';
      finishLink(link);
    }
  }

  // ---------- Import ----------

  function rebuild(accountId, chatJid, { incoming = false } = {}) {
    const msgs = store.waChatMessages(accountId, chatJid);
    if (!msgs.length) return;
    const name = store.waChatName(accountId, chatJid);
    const rec = chatToRecord(chatJid, msgs, { name, state: store.threadState(accountId, chatJid), incoming });
    store.upsertThread(accountId, rec, { syncFolder: true });
    if (isGroup(chatJid)) return; // un groupe n'est pas une personne : aucun contact créé
    const who = name || phoneOf(chatJid) || 'Contact WhatsApp';
    store.upsertAccountContact(accountId, chatJid, { id: contactId(accountId, chatJid), name: who, title: phoneOf(chatJid) || '', channel: 'whatsapp', last: dayLabel(msgs.at(-1).ts) });
  }

  function names(accountId, contacts) {
    const touched = new Set();
    for (const c of Array.isArray(contacts) ? contacts : []) {
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

  // Titres des groupes (métadonnées de groupe ou de discussion). Renvoie les groupes renommés.
  function groupTitles(accountId, list) {
    const touched = new Set();
    for (const g of Array.isArray(list) ? list : []) {
      const jid = chatJid(g?.id);
      const title = isGroup(jid) ? groupTitle(g) : null;
      if (!title) continue;
      store.waSetChatName(accountId, jid, title);
      touched.add(jid);
    }
    return touched;
  }

  function policies(accountId, s, chats) {
    for (const ch of Array.isArray(chats) ? chats : []) {
      const jid = chatJid(ch?.id);
      if (!jid || !Object.hasOwn(ch, 'ephemeralExpiration')) continue;
      const value = Number(ch.ephemeralExpiration);
      if (!Number.isFinite(value) || value < 0) continue;
      const ephemeral = value > 0;
      if (ephemeral) s.ephemeral.add(jid); else s.ephemeral.delete(jid);
      store.waSetEphemeral(accountId, jid, ephemeral);
    }
  }

  // Les lots d'un compte sont traités dans l'ordre. Un petit lot est traité tout de suite ; un gros lot d'historique
  // (Baileys fusionne les tranches reçues pendant la synchronisation initiale) l'est par tranches, avec une pause
  // entre deux pour ne pas bloquer le serveur. Une déconnexion (génération) interrompt le traitement en cours.
  function enqueue(accountId, s, kind, data, notify) {
    const size = Array.isArray(data?.messages) ? data.messages.length : 0;
    let job = null;
    const failed = () => {
      warn(`lot non importé pour le compte ${accountId}`);
      if (!current(accountId, s)) return;
      // Les tranches déjà enregistrées restent visibles ; le cycle ne pourra plus se déclarer complet.
      if (job) for (const jid of job.changed) try { rebuild(accountId, jid); } catch { /* fil suivant */ }
      lostHistory(accountId, 'Une partie de l’historique n’a pas pu être importée : actualise l’historique.');
      const h = histories.get(accountId);
      if (h) finishHistory(accountId, h, 'partial');
    };
    if (!s.ingest && size <= CHUNK) {
      try {
        job = prepare(accountId, s, kind, data, notify);
        if (job) { while (job.i < job.raw.length) step(job); finish(job); }
      } catch { failed(); }
      return;
    }
    s.ingest = (s.ingest || Promise.resolve()).then(async () => {
      job = prepare(accountId, s, kind, data, notify);
      if (!job) return;
      while (job.i < job.raw.length) {
        if (job.i) await new Promise(r => setImmediate(r));
        if (!current(accountId, s)) return;
        step(job);
      }
      finish(job);
    }).catch(failed);
    const tail = s.ingest;
    tail.then(() => { if (s.ingest === tail) s.ingest = null; });
  }

  function prepare(accountId, s, kind, data, notify) {
    if (!current(accountId, s)) return null;
    if (kind === 'chats' || kind === 'groups') {
      if (kind === 'chats') policies(accountId, s, data);
      const known = new Set(store.waChats(accountId));
      for (const jid of groupTitles(accountId, data)) if (known.has(jid)) rebuild(accountId, jid);
      return null;
    }
    if (kind === 'contacts') {
      const known = new Set(store.waChats(accountId));
      for (const jid of names(accountId, data)) if (known.has(jid)) rebuild(accountId, jid);
      return null;
    }
    if (kind === 'messages') fullResponses(accountId, s, data?.messages);
    const unread = new Set();
    if (kind === 'history') {
      policies(accountId, s, data?.chats);
      names(accountId, data?.contacts);
      groupTitles(accountId, data?.chats);
      for (const ch of Array.isArray(data?.chats) ? data.chats : []) {
        const jid = chatJid(ch?.id);
        if (!jid) continue;
        if (!isGroup(jid) && typeof ch.name === 'string' && ch.name.trim()) store.waSetChatName(accountId, jid, ch.name.trim().slice(0, 80));
        if (Number(ch.unreadCount) > 0) unread.add(jid);
      }
    }
    return { accountId, s, kind, data, notify, unread, i: 0, since: windowStart(accountId),
      raw: Array.isArray(data?.messages) ? data.messages : [], known: new Set(store.waChats(accountId)),
      changed: new Set(), incoming: new Set(), perChat: new Map(), added: 0 };
  }

  // Une tranche : aucun message n'est écarté avant le filtre (fenêtre, discussion directe, texte).
  function step(job) {
    const { accountId, s } = job;
    const list = job.raw.slice(job.i, job.i + CHUNK).map(m => parseMessage(m, { since: job.since })).filter(m => m && !s.ephemeral.has(m.chatJid));
    job.i += CHUNK;
    for (const m of list) {
      // Nom public de l'expéditeur seulement pour une discussion directe sans nom connu ; jamais comme titre de groupe.
      if (m.pushName && !isGroup(m.chatJid) && !store.waChatName(accountId, m.chatJid)) store.waSetChatName(accountId, m.chatJid, m.pushName);
      const c = job.perChat.get(m.chatJid) || { n: 0, oldest: m };
      c.n++;
      if (m.ts < c.oldest.ts) c.oldest = m;
      job.perChat.set(m.chatJid, c);
    }
    const inserted = store.waAddMessages(accountId, list);
    for (const jid of inserted) job.changed.add(jid);
    if (job.notify) for (const m of list) if (!m.fromMe && inserted.has(m.chatJid)) job.incoming.add(m.chatJid);
    job.added += list.length;
  }

  function finish(job) {
    const { accountId, s, data } = job;
    if (!current(accountId, s)) return;
    for (const jid of job.changed) rebuild(accountId, jid, { incoming: job.incoming.has(jid) || (job.unread.has(jid) && !job.known.has(jid)) });
    if (job.kind !== 'history') return;
    historyBatch(accountId, s, data, { added: job.added, chats: job.changed });
    if (Number(data?.syncType) === HISTORY_ON_DEMAND) continueOnDemand(accountId, s, job.perChat, job.since);
    if (data?.isLatest) settled(accountId, s);
  }

  // ---------- Historique ----------

  function pruneAndRebuild(accountId) {
    store.waPruneBefore(accountId, windowStart(accountId));
    for (const jid of store.waChats(accountId)) rebuild(accountId, jid);
  }

  function resetHistory(accountId) {
    const h = histories.get(accountId);
    if (h) clearTimeout(h.idle);
    histories.delete(accountId);
    requestOnOpen.delete(accountId);
  }

  const terminal = st => ['complete', 'partial', 'unavailable'].includes(st);

  function beginHistory(accountId, source, reason = null) {
    resetHistory(accountId);
    const h = { state: 'waiting', source, requestedAt: Date.now(), lastBatchAt: null, batches: 0, messages: 0, chats: new Set(),
      progress: null, reason, mode: source === 'link' ? 'initial' : null, idle: null, rounds: new Map(), outstanding: 0 };
    histories.set(accountId, h);
    store.setSync(accountId, { status: 'syncing', error: null });
    armIdle(accountId, h);
    return h;
  }

  function armIdle(accountId, h) {
    clearTimeout(h.idle);
    h.idle = setTimeout(() => {
      if (histories.get(accountId) !== h || terminal(h.state)) return;
      finishHistory(accountId, h, 'partial', h.batches
        ? 'Plus aucun lot reçu du téléphone : l’historique peut être incomplet.'
        : 'Le téléphone n’a envoyé aucun historique : vérifie qu’il est en ligne, puis actualise.');
    }, T.historyIdleMs);
    h.idle.unref?.();
  }

  function finishHistory(accountId, h, state, reason = null) {
    if (histories.get(accountId) !== h || terminal(h.state)) return;
    if (state === 'complete' && h.lost) state = 'partial';
    clearTimeout(h.idle);
    h.state = state;
    if (reason) h.reason = reason;
    if (!store.hasAccount(accountId)) return;
    const counts = store.countThreads(accountId);
    store.setSync(accountId, { status: 'idle', total: counts.threads, done: counts.threads, last_sync_at: new Date().toISOString(),
      error: state === 'complete' ? null : h.reason });
  }

  // Perte constatée (lot ignoré ou en échec) : le suivi ne pourra plus se déclarer complet.
  function lostHistory(accountId, reason) {
    const h = histories.get(accountId);
    if (!h) return;
    h.lost = true;
    h.reason = reason;
  }

  function historyBatch(accountId, s, data, { added, chats }) {
    const h = histories.get(accountId);
    if (!h || terminal(h.state)) return;
    h.state = 'receiving';
    h.batches++;
    h.lastBatchAt = Date.now();
    h.messages += added;
    for (const jid of chats) h.chats.add(jid);
    if (Number.isFinite(data?.progress)) h.progress = Math.max(0, Math.min(100, Number(data.progress)));
    store.setSync(accountId, { status: 'syncing' });
    armIdle(accountId, h);
    // Seule une progression explicite à 100 % du type attendu vaut fin ; isLatest ne suffit pas (Baileys le pose sur
    // le premier lot reçu).
    if (Number(data?.progress) === 100 && endsHistory(h, Number(data?.syncType))) finishHistory(accountId, h, 'complete');
  }

  // Type d'historique dont la fin explicite termine le suivi : RECENT pour une liaison, FULL pour la demande bornée.
  // L'historique discussion par discussion n'a pas de signal de fin : il s'achève au délai, donc « partiel ».
  const endsHistory = (h, type) => (h.mode === 'initial' && type === HISTORY_RECENT) || (h.mode === 'full' && type === HISTORY_FULL);

  function historyMilestone(accountId, st) {
    const h = histories.get(accountId);
    if (!h || terminal(h.state)) return;
    const type = Number(st?.syncType);
    if (type !== HISTORY_RECENT && type !== HISTORY_FULL) return; // l'amorçage initial seul ne couvre pas 7 jours
    // Un jalon « complete » peut précéder le téléchargement et l'import du lot final : il ne termine jamais le suivi.
    // Seul l'import d'un lot à 100 % du type attendu le fait (historyBatch).
    if (st.status === 'paused') finishHistory(accountId, h, 'partial', 'Le téléphone a interrompu l’envoi : l’historique peut être incomplet.');
  }

  // Réponse du téléphone à la demande d'historique complet (Baileys ne la remonte pas : message de protocole de soi à soi).
  function fullResponses(accountId, s, messages) {
    const h = histories.get(accountId);
    if (!h || h.mode !== 'full' || !Array.isArray(messages)) return;
    for (const m of messages) {
      const res = m?.key?.fromMe ? m.message?.protocolMessage?.peerDataOperationRequestResponseMessage : null;
      if (!res || Number(res.peerDataOperationRequestType) !== PDO_FULL_HISTORY_ON_DEMAND) continue;
      const result = (res.peerDataOperationResult || []).map(r => r?.fullHistorySyncOnDemandRequestResponse).find(Boolean);
      if (!result || result.requestMetadata?.requestId !== h.requestId) continue;
      clearTimeout(s.fullTimer);
      const code = Number(result.responseCode ?? 0);
      if (code === 0) { h.fullAccepted = true; armIdle(accountId, h); continue; }
      h.reason = FULL_RESPONSE[code] || 'Le téléphone n’a pas accepté la demande d’historique complet.';
      onDemandFallback(accountId, s, h);
    }
  }

  // Demande au téléphone l'historique des 7 derniers jours : d'abord l'historique complet borné à la fenêtre,
  // puis, si le téléphone le refuse ou ne répond pas, discussion par discussion depuis le plus ancien message connu.
  async function requestHistory(accountId, s) {
    const h = beginHistory(accountId, 'request');
    const days = store.getSync(accountId)?.window_days || 7;
    const { proto } = await lib();
    if (!current(accountId, s) || histories.get(accountId) !== h) return;
    if (typeof s.sock.sendPeerDataOperationMessage !== 'function') return onDemandFallback(accountId, s, h);
    h.mode = 'full';
    h.requestId = randomUUID();
    try {
      await s.sock.sendPeerDataOperationMessage({
        peerDataOperationRequestType: proto?.Message?.PeerDataOperationRequestType?.FULL_HISTORY_SYNC_ON_DEMAND ?? PDO_FULL_HISTORY_ON_DEMAND,
        fullHistorySyncOnDemandRequest: {
          requestMetadata: { requestId: h.requestId },
          historySyncConfig: { fullSyncDaysLimit: days, inlineInitialPayloadInE2EeMsg: true, supportGroupHistory: true, onDemandReady: true },
        },
      });
    } catch {
      if (current(accountId, s) && histories.get(accountId) === h) onDemandFallback(accountId, s, h);
      return;
    }
    if (!current(accountId, s) || histories.get(accountId) !== h) return;
    clearTimeout(s.fullTimer);
    s.fullTimer = setTimeout(() => {
      if (current(accountId, s) && histories.get(accountId) === h && !h.fullAccepted && !h.batches) {
        h.reason = 'Pas de réponse du téléphone à la demande d’historique complet.';
        onDemandFallback(accountId, s, h);
      }
    }, T.fullResponseMs);
    s.fullTimer.unref?.();
  }

  function onDemandFallback(accountId, s, h) {
    if (h.mode === 'chats' || terminal(h.state) || histories.get(accountId) !== h) return;
    h.mode = 'chats';
    const since = windowStart(accountId);
    const targets = [];
    for (const jid of store.waChats(accountId)) {
      const oldest = store.waChatMessages(accountId, jid)[0];
      if (oldest && oldest.ts >= since && !s.ephemeral.has(jid)) targets.push({ jid, oldest });
    }
    if (!targets.length) {
      return finishHistory(accountId, h, h.batches ? 'partial' : 'unavailable',
        h.reason || 'Aucune discussion connue à compléter : une nouvelle liaison est nécessaire pour importer les autres discussions.');
    }
    askChats(accountId, s, h, targets).catch(() => {});
  }

  async function askChats(accountId, s, h, targets) {
    if (typeof s.sock.fetchMessageHistory !== 'function') {
      return finishHistory(accountId, h, 'unavailable', 'Historique à la demande indisponible avec cette version du connecteur.');
    }
    for (const { jid, oldest } of targets) {
      if (!current(accountId, s) || histories.get(accountId) !== h || terminal(h.state)) return;
      const rounds = (h.rounds.get(jid) || 0) + 1;
      if (rounds > T.onDemandRounds) continue;
      h.rounds.set(jid, rounds);
      try {
        // Demande adressée à son propre téléphone (message de protocole), jamais au correspondant.
        await s.sock.fetchMessageHistory(T.onDemandCount, { remoteJid: jid, id: oldest.msgId, fromMe: oldest.fromMe }, oldest.ts);
        h.outstanding++;
      } catch { /* discussion suivante */ }
      armIdle(accountId, h);
      await new Promise(r => setTimeout(r, T.onDemandSpacingMs));
    }
  }

  // Un lot à la demande plein et encore dans la fenêtre : on redemande plus ancien, dans la limite des tours.
  function continueOnDemand(accountId, s, perChat, since) {
    const h = histories.get(accountId);
    if (!h || h.mode !== 'chats' || terminal(h.state)) return;
    const next = [];
    for (const [jid, c] of perChat) if (c.n >= T.onDemandCount && c.oldest.ts >= since) next.push({ jid, oldest: c.oldest });
    if (next.length) askChats(accountId, s, h, next).catch(() => {});
  }

  function historyView(accountId) {
    const h = histories.get(accountId);
    if (!h) return { state: 'idle', windowDays: store.getSync(accountId)?.window_days || 7 };
    return {
      state: h.state, source: h.source, mode: h.mode, windowDays: store.getSync(accountId)?.window_days || 7,
      requestedAt: new Date(h.requestedAt).toISOString(), lastBatchAt: h.lastBatchAt ? new Date(h.lastBatchAt).toISOString() : null,
      batches: h.batches, messages: h.messages, conversations: h.chats.size, progress: h.progress, reason: h.reason || null,
    };
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
      return { status: s.status, total: s.total, done: s.done, error: s.error, ...store.countThreads(accountId), history: historyView(accountId) };
    },
    // Demande réellement l'historique des 7 derniers jours au téléphone (session enregistrée, sans nouveau QR).
    async syncNow(accountId) {
      if (!isWhatsApp(accountId)) throw badRequest('Ce compte n’est pas un compte WhatsApp.');
      pruneAndRebuild(accountId);
      const h = histories.get(accountId);
      const busy = h && !terminal(h.state);
      const recent = h && Date.now() - h.requestedAt < T.requestCooldownMs;
      if (busy || recent || linkOf.has(accountId)) return this.progress(accountId);
      const s = sessions.get(accountId);
      if (s?.open && current(accountId, s)) {
        await requestHistory(accountId, s);
      } else if (hasSession({ store, vault, accountId })) {
        beginHistory(accountId, 'request', 'Reconnexion au téléphone avant la demande d’historique.');
        requestOnOpen.add(accountId);
        if (!sessions.has(accountId)) reopen(accountId, null);
      } else {
        const v = beginHistory(accountId, 'request');
        finishHistory(accountId, v, 'unavailable', 'Aucune session WhatsApp enregistrée : relie le téléphone.');
      }
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
