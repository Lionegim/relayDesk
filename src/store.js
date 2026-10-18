// Dépôt SQLite. Les routes ne voient que ces fonctions ; les secrets n'en sortent jamais par snapshot().
import { SERVICES } from './connectors.js';
import { badRequest, notFound } from './http/errors.js';
import { transaction } from './db/index.js';

const MAX_NAME = 80;
const MAX_DRAFT = 20000;
const FREQ_COUNT = 4;

const bool = v => !!v;
const toMessage = (r, full) => {
  const m = {
    id: r.id, p: r.profile_id, accountId: r.account_id, from: r.from_name, initials: r.initials, handle: r.handle, channel: r.channel,
    account: r.account, time: r.time_label, sortAt: r.sort_at, unread: bool(r.unread), flagged: bool(r.flagged), archived: bool(r.archived),
    folderId: r.folder_id, label: r.label, subject: r.subject, preview: r.preview, triage: r.triage, count: r.message_count,
    draft: r.draft_saved_at ? { savedAt: r.draft_saved_at, ...(full ? { text: r.draft_text } : {}) } : null,
  };
  if (full) Object.assign(m, { body: r.body, trail: JSON.parse(r.trail) });
  return m;
};
const toAccount = r => ({ id: r.id, name: r.name, channel: r.channel, svc: r.svc, status: r.status, c: r.c, address: r.address });

export function createStore(db) {
  const q = sql => db.prepare(sql);
  let seq = 0;

  const profile = id => q('SELECT * FROM profiles WHERE id = ?').get(id) || (() => { throw notFound('Profil introuvable'); })();
  const row = id => q('SELECT * FROM messages WHERE id = ?').get(id) || (() => { throw notFound('Message introuvable'); })();
  const name = (v, what) => {
    if (typeof v !== 'string' || !v.trim()) throw badRequest(`${what} requis`);
    if (v.trim().length > MAX_NAME) throw badRequest(`${what} trop long`);
    return v.trim();
  };
  const accountOf = id => q('SELECT * FROM accounts WHERE id = ?').get(id) || (() => { throw notFound('Compte introuvable'); })();

  return {
    db,

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
    getMessage: id => toMessage(row(id), true),

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

    saveDraft(id, text) {
      row(id);
      if (typeof text !== 'string' || text.length > MAX_DRAFT) throw badRequest('Brouillon invalide');
      const savedAt = new Date().toISOString();
      q('UPDATE messages SET draft_text = ?, draft_saved_at = ? WHERE id = ?').run(text, savedAt, id);
      return { text, savedAt };
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
      q(`INSERT INTO accounts (profile_id, name, channel, svc, status, c, address, position)
         VALUES (?, ?, ?, ?, 'Connexion…', 'info', ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM accounts))
         ON CONFLICT (profile_id, name) DO UPDATE SET svc = excluded.svc, channel = excluded.channel, address = COALESCE(excluded.address, accounts.address)`)
        .run(profileId, accountName, channel, svc, address);
      return toAccount(q('SELECT * FROM accounts WHERE profile_id = ? AND name = ?').get(profileId, accountName));
    },
    getAccount: id => ({ ...toAccount(accountOf(id)), profileId: accountOf(id).profile_id }),
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
      const id = `g${accountId}_${externalId}`.replace(/[^\w-]/g, '_');
      if (found) {
        // Seuls les dossiers créés par l'import suivent un renommage externe.
        // Ne jamais remplacer le nom d'un dossier local ou partagé par un chemin Gmail.
        const links = q('SELECT COUNT(*) AS n FROM folder_labels WHERE folder_id = ?').get(found.folder_id).n;
        if (found.folder_id === id && links === 1) q('UPDATE folders SET name = ? WHERE id = ? AND parent_id IS NULL').run(labelName, id);
        return found.folder_id;
      }
      q(`INSERT INTO folders (id, profile_id, name, parent_id, position)
         VALUES (?, ?, ?, NULL, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))`).run(id, acc.profile_id, labelName);
      this.linkFolderLabel(id, accountId, externalId);
      return id;
    },

    // Les brouillons sont conservés. Avec labels, le dossier suit aussi Gmail.
    upsertThread(accountId, t, { syncFolder = false } = {}) {
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
    countThreads(accountId) {
      return q(`SELECT COUNT(*) AS threads, COALESCE(SUM(message_count), 0) AS messages, COALESCE(SUM(label = 'À traiter'), 0) AS todo
                FROM messages WHERE account_id = ?`).get(accountId);
    },
    transaction: fn => transaction(db, fn),
  };
}
