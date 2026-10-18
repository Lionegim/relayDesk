// Dépôt SQLite. Les routes ne voient que ces fonctions ; les secrets n'en sortent jamais par snapshot().
import { createReplyMemoryRepository } from './ai/reply-memory.js';
import { SERVICES } from './connectors.js';
import { badRequest, notFound } from './http/errors.js';
import { transaction } from './db/index.js';

const MAX_NAME = 80;
const MAX_DRAFT = 20000;
const FREQ_COUNT = 4;

const bool = v => !!v;
const toMessage = (r, full) => {
  const m = {
    id: r.id, kind: r.compose_kind, p: r.profile_id, accountId: r.account_id, from: r.from_name, initials: r.initials, handle: r.handle, channel: r.channel,
    account: r.account, time: r.time_label, sortAt: r.sort_at, unread: bool(r.unread), flagged: bool(r.flagged), archived: bool(r.archived),
    folderId: r.folder_id, label: r.label, subject: r.subject, preview: r.preview, triage: r.triage, count: r.message_count,
    draft: r.draft_saved_at ? { savedAt: r.draft_saved_at, gmail: !!r.draft_synced, synced: !!r.draft_synced, ...(full ? { text: r.draft_text, mode: r.draft_mode, to: r.draft_to, cc: r.draft_cc, subject: r.subject } : {}) } : null,
  };
  if (full) Object.assign(m, { body: r.body, trail: JSON.parse(r.trail) });
  return m;
};
const toAccount = r => ({ id: r.id, name: r.name, channel: r.channel, svc: r.svc, status: r.status, c: r.c, address: r.address });

export function createStore(db) {
  const q = sql => db.prepare(sql);
  let seq = 0;
  const memory = createReplyMemoryRepository(db);

  const profile = id => q('SELECT * FROM profiles WHERE id = ?').get(id) || (() => { throw notFound('Profil introuvable'); })();
  const row = id => q('SELECT * FROM messages WHERE id = ?').get(id) || (() => { throw notFound('Message introuvable'); })();
  const name = (v, what) => {
    if (typeof v !== 'string' || !v.trim()) throw badRequest(`${what} requis`);
    if (v.trim().length > MAX_NAME) throw badRequest(`${what} trop long`);
    return v.trim();
  };
  const accountOf = id => q('SELECT * FROM accounts WHERE id = ?').get(id) || (() => { throw notFound('Compte introuvable'); })();

  function memoryScope(id) {
    const m = row(id);
    if (!m.account_id || !m.external_id || m.compose_kind === 'new') return null;
    const acc = accountOf(m.account_id);
    if (acc.profile_id !== m.profile_id || !['gmail','outlook','whatsapp'].includes(acc.svc)) return null;
    return {accountId:m.account_id,conversationId:m.external_id,profileId:m.profile_id};
  }

  return {
    db,
    pruneReplyMemory: () => memory.prune(),
    markAIReply(id,text) {memory.ignore(memoryScope(id),text);},
    learnAvailableReplies() {
      for(const m of q("SELECT id FROM messages WHERE channel='whatsapp' AND account_id IS NOT NULL").all()) this.getReplyMemory(m.id);
    },
    getReplyMemory(id, {internal=false}={}) {
      const scope=memoryScope(id);
      if(scope && accountOf(scope.accountId).svc==='whatsapp') {
        const sent=q('SELECT text,ts AS at FROM whatsapp_messages WHERE account_id=? AND chat_jid=? AND from_me=1 ORDER BY ts DESC LIMIT 100')
          .all(scope.accountId,scope.conversationId).map(m=>({...m,fromMe:true}));
        memory.observe(scope,sent);
      }
      const value=memory.view(scope);
      if(!internal) {const {promptExamples,revision,identity,learnAfter,...publicView}=value;return publicView;}
      return value;
    },
    changeReplyMemory(id, input) {
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['enabled','reset'].includes(k)) ||
        ('enabled' in input && typeof input.enabled!=='boolean') || ('reset' in input && input.reset!==true) || !Object.keys(input).length) throw badRequest('Réglage de mémoire invalide');
      const scope=memoryScope(id);if(!scope) throw badRequest('La mémoire nécessite une conversation et un compte connectés');
      memory.change(scope,input);return this.getReplyMemory(id);
    },
    // Après accusé de succès fournisseur seulement. Une erreur de mémoire ne transforme jamais un envoi réussi en échec.
    rememberReply(id,text,{ticket,at=Date.now()}={}) {
      try {
        const scope=memoryScope(id);if(!scope) return false;
        const current=memory.view(scope);
        if(ticket && current.identity!==ticket.identity) return false;
        if(ticket && current.revision!==ticket.revision && current.learnAfter>=at) {
          memory.ignore(scope,text,{remove:true});return false;
        }
        memory.observe(scope,[{fromMe:true,text,at}]);
      } catch {return false;}
      return true;
    },

    snapshot() {
      const accounts = q('SELECT * FROM accounts ORDER BY position, id').all();
      return {
        profiles: q('SELECT * FROM profiles ORDER BY position').all().map(p => ({
          id: p.id, name: p.name, kind: p.kind, initials: p.initials,
          accounts: accounts.filter(a => a.profile_id === p.id).map(toAccount),
        })),
        folders: q('SELECT id, profile_id AS p, name, parent_id AS parent FROM folders ORDER BY position, rowid').all().map(f => ({ ...f })),
        messages: q('SELECT * FROM messages ORDER BY sort_at DESC').all().map(r => toMessage(r, false)),
        contacts: q('SELECT * FROM contacts ORDER BY position').all().map(c => ({
          id: c.id, p: c.profile_id, name: c.name, title: c.title, freq: c.freq, ch: JSON.parse(c.channels), last: c.last, g: JSON.parse(c.groups), order: c.position,
        })),
      };
    },

    hasProfile: id => !!q('SELECT 1 FROM profiles WHERE id = ?').get(id),
    getMessage(id) {
      const r = row(id), m = toMessage(r, true);
      if (r.channel === 'whatsapp' && r.account_id && r.external_id) {
        const recent = q("SELECT m.from_me, m.ts, m.text, m.author_jid, COALESCE(c.name, NULLIF(m.sender_name, 'Participant'), m.sender_name) AS sender_name FROM whatsapp_messages m LEFT JOIN whatsapp_chats c ON c.account_id = m.account_id AND c.chat_jid = m.author_jid WHERE m.account_id = ? AND m.chat_jid = ? ORDER BY m.ts DESC, m.rowid DESC").all(r.account_id, r.external_id);
        m.group = r.external_id.endsWith('@g.us');
        m.fromMe = recent.length ? !!recent[0].from_me : false;
        m.at = m.sortAt;
        // Relire la source aussi pour les fils importés avant fromMe : un contact peut s'appeler « Moi ».
        if (recent.length) {
          if (m.group && !recent[0].from_me) m.from = recent[0].sender_name || 'Participant';
          const who = q('SELECT name FROM whatsapp_chats WHERE account_id = ? AND chat_jid = ?').get(r.account_id, r.external_id)?.name || m.subject.replace(/^WhatsApp · /, '');
          m.trail = recent.slice(1).map(t => {
            const from = t.from_me ? 'Moi' : m.group ? t.sender_name || 'Participant' : who;
            return { from, initials: from.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase(), fromMe: !!t.from_me, at: t.ts, body: t.text };
          });
        }
      }
      return m;
    },

    aiFolders(profileId) {
      return q('SELECT id, name FROM folders WHERE profile_id = ? ORDER BY position, id').all(profileId)
        .map(f => ({ id: f.id, name: this.folderPath(f.id) }));
    },
    getAIResult(id, kind) {
      row(id);
      const r = q('SELECT * FROM ai_results WHERE message_id = ? AND kind = ?').get(id, kind);
      return r ? { ...JSON.parse(r.result), fingerprint: r.fingerprint, proposalId: r.proposal_id, createdAt: r.created_at, appliedAt: r.applied_at } : null;
    },
    saveAIResult(id, kind, fingerprint, result, proposalId) {
      row(id);
      q(`INSERT INTO ai_results (message_id, kind, fingerprint, result, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (message_id, kind) DO UPDATE SET fingerprint = excluded.fingerprint, result = excluded.result,
        proposal_id = excluded.proposal_id, created_at = excluded.created_at, applied_at = NULL`)
        .run(id, kind, fingerprint, JSON.stringify(result), proposalId, new Date().toISOString());
      return this.getAIResult(id, kind);
    },
    markAIClassified(id, proposalId, folderId) {
      const result = this.getAIResult(id, 'classify');
      if (!result || result.proposalId !== proposalId) return;
      const { fingerprint, proposalId: ignored, createdAt, appliedAt, ...value } = result;
      q("UPDATE ai_results SET applied_at = ?, result = ? WHERE message_id = ? AND kind = 'classify' AND proposal_id = ?")
        .run(new Date().toISOString(), JSON.stringify({ ...value, suggestedFolderId: value.folderId, folderId }), id, proposalId);
    },

    // Validation partagée : aucun appel fournisseur ne précède ces contrôles.
    validateMessagePatch(id, patch) {
      const m = row(id), fields = {};
      for (const k of ['unread', 'flagged', 'archived']) {
        if (!(k in patch)) continue;
        if (typeof patch[k] !== 'boolean') throw badRequest(`${k} doit être un booléen`);
        fields[k] = patch[k];
      }
      if ('folderId' in patch) {
        const f = patch.folderId;
        if (f !== null && !q('SELECT 1 FROM folders WHERE id = ? AND profile_id = ?').get(f, m.profile_id)) throw badRequest('Dossier invalide pour ce profil');
        fields.folderId = f;
      }
      return fields;
    },

    getMessageSource(id) {
      const m = row(id);
      return { accountId: m.account_id, externalId: m.external_id, folderId: m.folder_id };
    },
    getThreadFolder(accountId, externalId) {
      return q('SELECT folder_id FROM messages WHERE account_id = ? AND external_id = ?').get(accountId, externalId)?.folder_id ?? null;
    },

    updateMessage(id, patch) {
      const fields = this.validateMessagePatch(id, patch);
      const columns = { unread: 'unread', flagged: 'flagged', archived: 'archived', folderId: 'folder_id' };
      const keys = Object.keys(fields);
      if (keys.length) q(`UPDATE messages SET ${keys.map(k => `${columns[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map(k => k === 'folderId' ? fields[k] : +fields[k]), id);
      return toMessage(row(id), false);
    },

    // `synced` : le contenu enregistré est aussi celui du brouillon Gmail. Un enregistrement local garde le lien
    // vers le brouillon Gmail existant (pour le mettre à jour ensuite) mais le marque comme non synchronisé.
    // `threadKey` : empreinte du rattachement au fil du brouillon distant ; undefined la conserve, null l'efface.
    saveDraft(id, text, { mode = null, to = null, cc = null, subject, externalId, synced = false, threadKey } = {}) {
      const r = row(id);
      if (typeof text !== 'string' || text.length > MAX_DRAFT) throw badRequest('Brouillon invalide');
      if (r.compose_kind === 'new') {
        if (mode !== 'new') throw badRequest('Ce brouillon est un nouveau message');
        if (typeof subject !== 'string' || subject.length > 998 || /[\r\n\0]/.test(subject)) throw badRequest('Objet invalide');
      }
      const savedAt = new Date().toISOString();
      const ext = externalId === undefined ? r.draft_external_id : externalId;
      q('UPDATE messages SET draft_text = ?, draft_saved_at = ?, draft_mode = ?, draft_to = ?, draft_external_id = ?, draft_synced = ? WHERE id = ?')
        .run(text, savedAt, mode, to, ext, +(synced && !!ext), id);
      if (threadKey !== undefined) q('UPDATE messages SET draft_thread_key = ? WHERE id = ?').run(threadKey, id);
      if (r.compose_kind === 'new') q('UPDATE messages SET subject = ?, draft_cc = ?, preview = ?, sort_at = ? WHERE id = ?').run(subject, cc, text.slice(0, 200), Date.now(), id);
      return { text, savedAt, mode, to, cc, subject: subject ?? r.subject, gmail: synced && !!ext, synced: synced && !!ext };
    },
    createComposition(accountId) {
      const acc = accountOf(accountId);
      if (acc.channel !== 'email' || !['gmail', 'outlook'].includes(acc.svc)) throw badRequest('Choisis un compte de messagerie compatible');
      const now = Date.now();
      const id = Number(q(`INSERT INTO messages (profile_id, account_id, from_name, initials, handle, channel, account, sort_at, label, subject, preview, body, triage, compose_kind, draft_mode, draft_text, draft_saved_at)
        VALUES (?, ?, 'Moi', 'M', ?, 'email', ?, ?, 'Brouillon', '', '', '', '', 'new', 'new', '', ?)`)
        .run(acc.profile_id, accountId, acc.address || '', acc.name, now, new Date(now).toISOString()).lastInsertRowid);
      return toMessage(row(id), true);
    },
    setReplyMeta(id, reply) {
      q('UPDATE messages SET reply_meta = ? WHERE id = ?').run(JSON.stringify(reply), id);
    },
    clearDraft(id) {
      if (row(id).compose_kind === 'new') { q('DELETE FROM messages WHERE id = ?').run(id); return; }
      q('UPDATE messages SET draft_text = NULL, draft_saved_at = NULL, draft_mode = NULL, draft_to = NULL, draft_external_id = NULL, draft_synced = 0, draft_thread_key = NULL WHERE id = ?').run(id);
    },
    // Lots C et D : de quoi construire une réponse dans le fil.
    composeContext(id) {
      const r = row(id);
      return {
        kind: r.compose_kind, cc: r.draft_cc, to: r.draft_to, accountId: r.account_id, threadId: r.external_id, subject: r.subject, body: r.body, sortAt: r.sort_at,
        reply: r.reply_meta ? JSON.parse(r.reply_meta) : null, draftExternalId: r.draft_external_id, draftThreadKey: r.draft_thread_key,
      };
    },

    createFolder({ profileId, name: raw, parentId = null }) {
      profile(profileId);
      if (parentId !== null && !q('SELECT 1 FROM folders WHERE id = ? AND profile_id = ?').get(parentId, profileId)) throw badRequest('Dossier parent invalide');
      const folder = { id: `f${Date.now().toString(36)}${(seq++).toString(36)}`, p: profileId, name: name(raw, 'Nom du dossier'), parent: parentId };
      q('INSERT INTO folders (id, profile_id, name, parent_id, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))')
        .run(folder.id, folder.p, folder.name, folder.parent);
      return folder;
    },

    updateContact(id, patch) {
      if (!q('SELECT 1 FROM contacts WHERE id = ?').get(id)) throw notFound('Contact introuvable');
      if (!Number.isInteger(patch.freq) || patch.freq < 0 || patch.freq >= FREQ_COUNT) throw badRequest('Fréquence invalide');
      q('UPDATE contacts SET freq = ? WHERE id = ?').run(patch.freq, id);
      return { id, freq: patch.freq };
    },

    // Connexion simulée (services sans adaptateur réel).
    connectAccount(profileId, { name: raw, svc }) {
      profile(profileId);
      const def = SERVICES[svc];
      if (!def || def.disabled) throw badRequest('Service indisponible');
      if (def.real) throw badRequest('Ce service se connecte par son autorisation réelle');
      const acc = this.upsertAccount(profileId, { name: name(raw, 'Nom du compte'), channel: def.ch, svc });
      return this.setAccountStatus(acc.id, 'Connecté', 'ok');
    },

    // ---------- Comptes réels ----------

    upsertAccount(profileId, { name: accountName, channel, svc, address = null }) {
      const existing = q('SELECT svc, address FROM accounts WHERE profile_id = ? AND name = ?').get(profileId, accountName);
      if (existing && (existing.svc !== svc || (existing.address && address && existing.address.toLowerCase() !== address.toLowerCase()))) {
        throw badRequest('Ce nom est déjà utilisé par un autre compte. Choisis un nom différent.');
      }
      q(`INSERT INTO accounts (profile_id, name, channel, svc, status, c, address, position)
         VALUES (?, ?, ?, ?, 'Connexion…', 'info', ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM accounts))
         ON CONFLICT (profile_id, name) DO UPDATE SET svc = excluded.svc, channel = excluded.channel, address = COALESCE(excluded.address, accounts.address)`)
        .run(profileId, accountName, channel, svc, address);
      return toAccount(q('SELECT * FROM accounts WHERE profile_id = ? AND name = ?').get(profileId, accountName));
    },
    getAccount: id => ({ ...toAccount(accountOf(id)), profileId: accountOf(id).profile_id }),
    hasAccount: id => !!q('SELECT 1 FROM accounts WHERE id = ?').get(id),
    // Supprime le compte ; secret, état de synchronisation, messages importés et liens folder_labels suivent (ON DELETE CASCADE).
    // Les dossiers restent : ceux importés avant la migration 002 sont d'abord détachés de leur compte d'origine.
    deleteAccount(id) {
      accountOf(id);
      transaction(db, () => {
        q('UPDATE folders SET account_id = NULL, external_id = NULL WHERE account_id = ?').run(id);
        q('DELETE FROM accounts WHERE id = ?').run(id);
      });
    },
    accountsBySvc: svc => q('SELECT id FROM accounts WHERE svc = ?').all(svc).map(r => r.id),
    setAccountStatus(id, status, c) {
      q('UPDATE accounts SET status = ?, c = ? WHERE id = ?').run(status, c, id);
      return toAccount(accountOf(id));
    },

    putSecret(accountId, { iv, tag, ciphertext }) {
      q(`INSERT INTO secrets (account_id, iv, tag, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
        .run(accountId, iv, tag, ciphertext, new Date().toISOString());
    },
    getSecret: accountId => q('SELECT iv, tag, ciphertext FROM secrets WHERE account_id = ?').get(accountId) || null,

    getSync: accountId => q('SELECT * FROM sync_state WHERE account_id = ?').get(accountId) || null,
    setSync(accountId, fields) {
      const cur = this.getSync(accountId) || { status: 'idle', history_id: null, window_days: 30, total: 0, done: 0, error: null, last_sync_at: null };
      const next = { ...cur, ...fields };
      q(`INSERT INTO sync_state (account_id, status, history_id, window_days, total, done, error, last_sync_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET status = excluded.status, history_id = excluded.history_id, window_days = excluded.window_days,
         total = excluded.total, done = excluded.done, error = excluded.error, last_sync_at = excluded.last_sync_at`)
        .run(accountId, next.status, next.history_id, next.window_days, next.total, next.done, next.error, next.last_sync_at);
      return next;
    },

    // Liens par compte : un même dossier local peut correspondre à plusieurs libellés Gmail.
    folderLabel(folderId, accountId) {
      return q('SELECT label_id FROM folder_labels WHERE folder_id = ? AND account_id = ?').get(folderId, accountId)?.label_id ?? null;
    },
    linkFolderLabel(folderId, accountId, labelId) {
      const acc = accountOf(accountId);
      if (!q('SELECT 1 FROM folders WHERE id = ? AND profile_id = ?').get(folderId, acc.profile_id)) throw badRequest('Dossier invalide pour ce profil');
      q(`INSERT INTO folder_labels (folder_id, account_id, label_id) VALUES (?, ?, ?)
         ON CONFLICT (folder_id, account_id) DO UPDATE SET label_id = excluded.label_id`).run(folderId, accountId, labelId);
    },
    folderPath(folderId) {
      const parts = [], seen = new Set();
      let id = folderId;
      while (id !== null) {
        if (seen.has(id)) throw badRequest('Hiérarchie de dossiers invalide');
        seen.add(id);
        const f = q('SELECT name, parent_id FROM folders WHERE id = ?').get(id);
        if (!f) throw badRequest('Dossier introuvable');
        parts.unshift(f.name);
        id = f.parent_id;
      }
      return parts.join('/');
    },
    ensureLabelFolder(accountId, externalId, labelName) {
      const acc = accountOf(accountId);
      const found = q('SELECT folder_id FROM folder_labels WHERE account_id = ? AND label_id = ?').get(accountId, externalId);
      const base = `g${accountId}_${externalId}`.replace(/[^\w-]/g, '_');
      // Un dossier issu d'un compte déconnecté peut porter le même identifiant (identifiant de compte réutilisé).
      const id = !found && q('SELECT 1 FROM folders WHERE id = ?').get(base) ? `${base}_${Date.now().toString(36)}` : base;
      if (found) {
        // Seuls les dossiers créés par l'import suivent un renommage externe.
        // Ne jamais remplacer le nom d'un dossier local ou partagé par un chemin Gmail.
        const links = q('SELECT COUNT(*) AS n FROM folder_labels WHERE folder_id = ?').get(found.folder_id).n;
        if ((found.folder_id === base || found.folder_id.startsWith(base + '_')) && links === 1) q('UPDATE folders SET name = ? WHERE id = ? AND parent_id IS NULL').run(labelName, found.folder_id);
        return found.folder_id;
      }
      q(`INSERT INTO folders (id, profile_id, name, parent_id, position)
         VALUES (?, ?, ?, NULL, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))`).run(id, acc.profile_id, labelName);
      this.linkFolderLabel(id, accountId, externalId);
      return id;
    },

    // Les brouillons sont conservés. Avec labels, le dossier suit aussi Gmail.
    upsertThread(accountId, t, opts) {
      const id = this.writeThread(accountId, t, opts);
      if (t.reply) q('UPDATE messages SET reply_meta = ? WHERE id = ?').run(JSON.stringify(t.reply), id);
      if (t.ownSamples?.length) memory.observe(memoryScope(id),t.ownSamples);
      return id;
    },
    writeThread(accountId, t, { syncFolder = false } = {}) {
      const acc = accountOf(accountId);
      const existing = q('SELECT id FROM messages WHERE account_id = ? AND external_id = ?').get(accountId, t.externalId);
      const vals = [t.from, t.initials, t.handle, t.sortAt, +t.unread, +t.flagged, t.label, t.subject, t.preview, t.body, t.triage, JSON.stringify(t.trail), t.count];
      if (existing) {
        q(`UPDATE messages SET from_name = ?, initials = ?, handle = ?, sort_at = ?, unread = ?, flagged = ?, label = ?, subject = ?, preview = ?, body = ?,
           triage = ?, trail = ?, message_count = ?, archived = ?${syncFolder ? ", folder_id = ?" : ""} WHERE id = ?`).run(...vals, +t.archived, ...(syncFolder ? [t.folderId ?? null] : []), existing.id);
        return existing.id;
      }
      return Number(q(`INSERT INTO messages (from_name, initials, handle, sort_at, unread, flagged, label, subject, preview, body, triage, trail, message_count,
         archived, folder_id, profile_id, account_id, external_id, channel, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...vals, +t.archived, t.folderId ?? null, acc.profile_id, accountId, t.externalId, acc.channel, acc.name).lastInsertRowid);
    },
    removeThread(accountId, externalId) {
      q('DELETE FROM messages WHERE account_id = ? AND external_id = ?').run(accountId, externalId);
    },
    // État local d'un fil (lu, drapeau, archive) : les fournisseurs sans état distant le conservent à la réécriture.
    threadState(accountId, externalId) {
      const r = q('SELECT id, unread, flagged, archived, folder_id FROM messages WHERE account_id = ? AND external_id = ?').get(accountId, externalId);
      return r ? { id: r.id, unread: !!r.unread, flagged: !!r.flagged, archived: !!r.archived, folderId: r.folder_id } : null;
    },

    // ---------- WhatsApp ----------

    // Valeurs chiffrées par le coffre ; ce dépôt ne voit que { iv, tag, ciphertext }.
    waAuthGet(accountId, kind, keyId) {
      return q('SELECT iv, tag, ciphertext FROM whatsapp_auth WHERE account_id = ? AND kind = ? AND key_id = ?').get(accountId, kind, keyId) || null;
    },
    waAuthSet(accountId, kind, keyId, sealed) {
      if (!sealed) { q('DELETE FROM whatsapp_auth WHERE account_id = ? AND kind = ? AND key_id = ?').run(accountId, kind, keyId); return; }
      q(`INSERT INTO whatsapp_auth (account_id, kind, key_id, iv, tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, kind, key_id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext`)
        .run(accountId, kind, keyId, sealed.iv, sealed.tag, sealed.ciphertext);
    },
    waAuthClear(accountId) {
      q('DELETE FROM whatsapp_auth WHERE account_id = ?').run(accountId);
    },
    // Messages : { chatJid, msgId, fromMe, ts, text }. Renvoie les discussions qui ont reçu au moins un nouveau message.
    waAddMessages(accountId, list) {
      const ins = q('INSERT OR IGNORE INTO whatsapp_messages (account_id, chat_jid, msg_id, from_me, ts, text, author_jid, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const changed = new Set();
      transaction(db, () => {
        for (const m of list) if (ins.run(accountId, m.chatJid, m.msgId, +m.fromMe, m.ts, m.text, m.participantJid || null, m.senderName || null).changes) changed.add(m.chatJid);
      });
      const scope={accountId,conversationId:null,profileId:accountOf(accountId).profile_id};
      for(const jid of new Set(list.filter(m=>m.fromMe).map(m=>m.chatJid))) {
        const persisted=q('SELECT text,ts AS at FROM whatsapp_messages WHERE account_id=? AND chat_jid=? AND from_me=1 ORDER BY ts DESC LIMIT 100').all(accountId,jid);
        memory.observe({...scope,conversationId:jid},persisted.map(m=>({...m,fromMe:true})));
      }
      return changed;
    },
    // Tous les textes de la fenêtre importée ; une lecture ne supprime jamais les messages précédents.
    waChatMessages(accountId, chatJid) {
      return q("SELECT m.msg_id, m.from_me, m.ts, m.text, m.author_jid, COALESCE(c.name, NULLIF(m.sender_name, 'Participant'), m.sender_name) AS sender_name FROM whatsapp_messages m LEFT JOIN whatsapp_chats c ON c.account_id = m.account_id AND c.chat_jid = m.author_jid WHERE m.account_id = ? AND m.chat_jid = ? ORDER BY m.ts, m.rowid").all(accountId, chatJid)
        .map(r => ({ msgId: r.msg_id, fromMe: !!r.from_me, ts: r.ts, text: r.text, participantJid: r.author_jid, senderName: r.sender_name }));
    },
    waPruneBefore(accountId, since) {
      transaction(db, () => {
        q('DELETE FROM whatsapp_messages WHERE account_id = ? AND ts < ?').run(accountId, since);
        q('DELETE FROM messages WHERE account_id = ? AND external_id NOT IN (SELECT DISTINCT chat_jid FROM whatsapp_messages WHERE account_id = ?)').run(accountId, accountId);
        q('DELETE FROM contacts WHERE account_id = ? AND external_id NOT IN (SELECT DISTINCT chat_jid FROM whatsapp_messages WHERE account_id = ?)').run(accountId, accountId);
      });
    },
    waChats(accountId) {
      return q('SELECT DISTINCT chat_jid FROM whatsapp_messages WHERE account_id = ?').all(accountId).map(r => r.chat_jid);
    },
    waChatCount(accountId) {
      return q('SELECT COUNT(DISTINCT chat_jid) AS n FROM whatsapp_messages WHERE account_id = ?').get(accountId).n;
    },
    waChatName(accountId, chatJid) {
      return q('SELECT name FROM whatsapp_chats WHERE account_id = ? AND chat_jid = ?').get(accountId, chatJid)?.name ?? null;
    },
    waEphemeralChats(accountId) {
      return q('SELECT chat_jid FROM whatsapp_chats WHERE account_id = ? AND ephemeral = 1').all(accountId).map(r => r.chat_jid);
    },
    waSetEphemeral(accountId, chatJid, ephemeral) {
      q(`INSERT INTO whatsapp_chats (account_id, chat_jid, ephemeral) VALUES (?, ?, ?)
        ON CONFLICT (account_id, chat_jid) DO UPDATE SET ephemeral = excluded.ephemeral`).run(accountId, chatJid, +ephemeral);
      if (ephemeral) transaction(db, () => {
        memory.forget({accountId,conversationId:chatJid});
        q('DELETE FROM whatsapp_messages WHERE account_id = ? AND chat_jid = ?').run(accountId, chatJid);
        q('DELETE FROM messages WHERE account_id = ? AND external_id = ?').run(accountId, chatJid);
        q('DELETE FROM contacts WHERE account_id = ? AND external_id = ?').run(accountId, chatJid);
      });
    },
    // Un nom vide ne remplace jamais un nom connu.
    waSetChatName(accountId, chatJid, name) {
      q(`INSERT INTO whatsapp_chats (account_id, chat_jid, name) VALUES (?, ?, ?)
         ON CONFLICT (account_id, chat_jid) DO UPDATE SET name = COALESCE(excluded.name, whatsapp_chats.name)`).run(accountId, chatJid, name || null);
    },
    waClearMessages(accountId) {
      transaction(db, () => {
        q('DELETE FROM whatsapp_messages WHERE account_id = ?').run(accountId);
        q('DELETE FROM whatsapp_chats WHERE account_id = ?').run(accountId);
      });
    },

    // Contact rattaché à un compte (dernière interaction). Fréquence, groupes et position choisis par l'utilisateur sont conservés.
    upsertAccountContact(accountId, externalId, { id, name: contactName, title = '', channel, last }) {
      const acc = accountOf(accountId);
      q(`INSERT INTO contacts (id, profile_id, name, title, freq, channels, last, groups, position, account_id, external_id)
         VALUES (?, ?, ?, ?, 0, ?, ?, '[]', (SELECT COALESCE(MAX(position), 0) + 1 FROM contacts), ?, ?)
         ON CONFLICT (account_id, external_id) DO UPDATE SET name = excluded.name, title = excluded.title, last = excluded.last`)
        .run(id, acc.profile_id, contactName, title, JSON.stringify([channel]), last, accountId, externalId);
    },

    countThreads(accountId) {
      return q(`SELECT COUNT(*) AS threads, COALESCE(SUM(message_count), 0) AS messages, COALESCE(SUM(label = 'À traiter'), 0) AS todo
                FROM messages WHERE account_id = ? AND compose_kind != 'new'`).get(accountId);
    },
    transaction: fn => transaction(db, fn),
  };
}
